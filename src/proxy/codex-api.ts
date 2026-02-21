/**
 * CodexApi — client for the Codex Responses API.
 *
 * Endpoint: POST /backend-api/codex/responses
 * This is the API the Codex CLI actually uses.
 * It requires: instructions, store: false, stream: true.
 *
 * All upstream requests go through the TLS transport layer
 * (curl CLI or libcurl FFI) to avoid Cloudflare TLS fingerprinting.
 */

import { getConfig } from "../config.js";
import { getTransport } from "../tls/transport.js";
import {
  buildHeaders,
  buildHeadersWithContentType,
} from "../fingerprint/manager.js";
import type { CookieJar } from "./cookie-jar.js";

export interface CodexResponsesRequest {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  stream: true;
  store: false;
  /** Optional: reasoning effort level */
  reasoning?: { effort: string };
  /** Optional: tools available to the model */
  tools?: unknown[];
  /** Optional: previous response ID for multi-turn */
  previous_response_id?: string | null;
}

export type CodexInputItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "system"; content: string };

/** Parsed SSE event from the Codex Responses stream */
export interface CodexSSEEvent {
  event: string;
  data: unknown;
}

export class CodexApi {
  private token: string;
  private accountId: string | null;
  private cookieJar: CookieJar | null;
  private entryId: string | null;

  constructor(
    token: string,
    accountId: string | null,
    cookieJar?: CookieJar | null,
    entryId?: string | null,
  ) {
    this.token = token;
    this.accountId = accountId;
    this.cookieJar = cookieJar ?? null;
    this.entryId = entryId ?? null;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** Build headers with cookies injected. */
  private applyHeaders(headers: Record<string, string>): Record<string, string> {
    if (this.cookieJar && this.entryId) {
      const cookie = this.cookieJar.getCookieHeader(this.entryId);
      if (cookie) headers["Cookie"] = cookie;
    }
    return headers;
  }

  /** Capture Set-Cookie headers from transport response into the jar. */
  private captureCookies(setCookieHeaders: string[]): void {
    if (this.cookieJar && this.entryId && setCookieHeaders.length > 0) {
      this.cookieJar.captureRaw(this.entryId, setCookieHeaders);
    }
  }

  /**
   * Query official Codex usage/quota.
   * GET /backend-api/codex/usage
   */
  async getUsage(): Promise<CodexUsageResponse> {
    const config = getConfig();
    const transport = getTransport();
    const url = `${config.api.base_url}/codex/usage`;

    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["Accept"] = "application/json";
    // When transport lacks Chrome TLS fingerprint, downgrade Accept-Encoding
    // to encodings system curl can always decompress.
    if (!transport.isImpersonate()) {
      headers["Accept-Encoding"] = "gzip, deflate";
    }

    let body: string;
    try {
      const result = await transport.get(url, headers, 15);
      body = result.body;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, `transport GET failed: ${msg}`);
    }

    try {
      const parsed = JSON.parse(body) as CodexUsageResponse;
      // Validate we got actual usage data (not an error page)
      if (!parsed.rate_limit) {
        throw new CodexApiError(502, `Unexpected response: ${body.slice(0, 200)}`);
      }
      return parsed;
    } catch (e) {
      if (e instanceof CodexApiError) throw e;
      throw new CodexApiError(502, `Invalid JSON from /codex/usage: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Create a response (streaming).
   * Returns the raw Response so the caller can process the SSE stream.
   */
  async createResponse(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const config = getConfig();
    const transport = getTransport();
    const baseUrl = config.api.base_url;
    const url = `${baseUrl}/codex/responses`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    headers["Accept"] = "text/event-stream";

    const timeout = config.api.timeout_seconds;

    let transportRes;
    try {
      transportRes = await transport.post(url, headers, JSON.stringify(request), signal, timeout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, msg);
    }

    // Capture cookies
    this.captureCookies(transportRes.setCookieHeaders);

    if (transportRes.status < 200 || transportRes.status >= 300) {
      // Read the body for error details (cap at 1MB to prevent memory spikes)
      const MAX_ERROR_BODY = 1024 * 1024; // 1MB
      const reader = transportRes.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize <= MAX_ERROR_BODY) {
          chunks.push(value);
        } else {
          const overshoot = totalSize - MAX_ERROR_BODY;
          if (value.byteLength > overshoot) {
            chunks.push(value.subarray(0, value.byteLength - overshoot));
          }
          reader.cancel();
          break;
        }
      }
      const errorBody = Buffer.concat(chunks).toString("utf-8");
      throw new CodexApiError(transportRes.status, errorBody);
    }

    return new Response(transportRes.body, {
      status: transportRes.status,
      headers: transportRes.headers,
    });
  }

  /**
   * Parse SSE stream from a Codex Responses API response.
   * Yields individual events.
   */
  async *parseStream(
    response: Response,
  ): AsyncGenerator<CodexSSEEvent> {
    if (!response.body) {
      throw new Error("Response body is null — cannot stream");
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    const MAX_SSE_BUFFER = 10 * 1024 * 1024; // 10MB
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        if (buffer.length > MAX_SSE_BUFFER) {
          throw new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER} bytes — aborting stream`);
        }
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          if (!part.trim()) continue;
          const evt = this.parseSSEBlock(part);
          if (evt) yield evt;
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const evt = this.parseSSEBlock(buffer);
        if (evt) yield evt;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSSEBlock(block: string): CodexSSEEvent | null {
    let event = "";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!event && dataLines.length === 0) return null;

    const raw = dataLines.join("\n");
    if (raw === "[DONE]") return null;

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }

    return { event, data };
  }
}

/** Response from GET /backend-api/codex/usage */
export interface CodexUsageRateWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface CodexUsageRateLimit {
  allowed: boolean;
  limit_reached: boolean;
  primary_window: CodexUsageRateWindow | null;
  secondary_window: CodexUsageRateWindow | null;
}

export interface CodexUsageResponse {
  plan_type: string;
  rate_limit: CodexUsageRateLimit;
  code_review_rate_limit: CodexUsageRateLimit | null;
  credits: unknown;
  promo: unknown;
}

export class CodexApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    let detail: string;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.detail ?? parsed.error?.message ?? body;
    } catch {
      detail = body;
    }
    super(`Codex API error (${status}): ${detail}`);
  }
}
