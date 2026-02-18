/**
 * CodexApi — client for the Codex Responses API.
 *
 * Endpoint: POST /backend-api/codex/responses
 * This is the API the Codex CLI actually uses.
 * It requires: instructions, store: false, stream: true.
 */

import { execFile } from "child_process";
import { getConfig } from "../config.js";
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

  /** Capture Set-Cookie headers from a response into the jar. */
  private captureCookies(response: Response): void {
    if (this.cookieJar && this.entryId) {
      this.cookieJar.capture(this.entryId, response);
    }
  }

  /**
   * Query official Codex usage/quota.
   * GET /backend-api/codex/usage
   *
   * Uses curl subprocess instead of Node.js fetch because Cloudflare
   * fingerprints the TLS handshake and blocks Node.js/undici requests
   * with a JS challenge (403). System curl uses native TLS (WinSSL/SecureTransport)
   * which Cloudflare accepts.
   */
  async getUsage(): Promise<CodexUsageResponse> {
    const config = getConfig();
    const url = `${config.api.base_url}/codex/usage`;

    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["Accept"] = "application/json";
    // Remove Accept-Encoding — let curl negotiate its own supported encodings
    // via --compressed. Passing unsupported encodings (br, zstd) causes curl
    // to fail when it can't decompress the response.
    delete headers["Accept-Encoding"];

    // Build curl args
    const args = ["-s", "--compressed", "--max-time", "15"];
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url);

    const body = await new Promise<string>((resolve, reject) => {
      execFile("curl", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new CodexApiError(0, `curl failed: ${err.message} ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });

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
    const baseUrl = config.api.base_url; // https://chatgpt.com/backend-api
    const url = `${baseUrl}/codex/responses`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    headers["Accept"] = "text/event-stream";

    const timeout = config.api.timeout_seconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: mergedSignal,
    }).finally(() => clearTimeout(timer));

    this.captureCookies(res);

    if (!res.ok) {
      let errorBody: string;
      try {
        errorBody = await res.text();
      } catch {
        errorBody = `HTTP ${res.status}`;
      }
      throw new CodexApiError(res.status, errorBody);
    }

    return res;
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

    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
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
