/**
 * CodexApi — client for the Codex Responses API.
 *
 * Endpoint: POST /backend-api/codex/responses
 * This is the API the Codex CLI actually uses.
 * It requires: instructions, store: false, stream: true.
 *
 * Both GET and POST requests use curl subprocess to avoid
 * Cloudflare TLS fingerprinting of Node.js/undici.
 */

import { spawn, execFile } from "child_process";
import { getConfig } from "../config.js";
import { resolveCurlBinary, getChromeTlsArgs, getProxyArgs, isImpersonate } from "../tls/curl-binary.js";
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

interface CurlResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  setCookieHeaders: string[];
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

  /** Capture Set-Cookie headers from curl response into the jar. */
  private captureCookiesFromCurl(setCookieHeaders: string[]): void {
    if (this.cookieJar && this.entryId && setCookieHeaders.length > 0) {
      this.cookieJar.captureRaw(this.entryId, setCookieHeaders);
    }
  }

  /**
   * Execute a POST request via curl subprocess.
   * Returns headers + streaming body as a CurlResponse.
   */
  private curlPost(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    timeoutSec?: number,
  ): Promise<CurlResponse> {
    return new Promise((resolve, reject) => {
      const args = [
        ...getChromeTlsArgs(), // Chrome TLS profile (ciphers, HTTP/2, etc.)
        ...getProxyArgs(),     // HTTP/SOCKS5 proxy if configured
        "-s", "-S",            // silent but show errors
        "--compressed",         // curl negotiates compression
        "-N",                   // no output buffering (SSE)
        "-i",                   // include response headers in stdout
        "-X", "POST",
        "--data-binary", "@-",  // read body from stdin
      ];

      if (timeoutSec) {
        args.push("--max-time", String(timeoutSec));
      }

      // Pass all headers explicitly in our fingerprint order.
      // Accept-Encoding is kept so curl doesn't inject its own at position 2.
      // --compressed still handles auto-decompression of the response.
      for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
      }
      // Suppress curl's auto Expect: 100-continue (Chromium never sends it)
      args.push("-H", "Expect:");
      args.push(url);

      const child = spawn(resolveCurlBinary(), args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Abort handling
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      if (signal) {
        if (signal.aborted) {
          child.kill("SIGTERM");
          reject(new Error("Aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Write body to stdin then close
      child.stdin.write(body);
      child.stdin.end();

      let headerBuf = Buffer.alloc(0);
      let headersParsed = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;

      // P0-1: Header parse timeout — kill curl if headers aren't received within 30s
      const HEADER_TIMEOUT_MS = 30_000;
      const headerTimer = setTimeout(() => {
        if (!headersParsed) {
          child.kill("SIGTERM");
          reject(new CodexApiError(0, `curl header parse timeout after ${HEADER_TIMEOUT_MS}ms`));
        }
      }, HEADER_TIMEOUT_MS);
      if (headerTimer.unref) headerTimer.unref();

      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          bodyController = c;
        },
        cancel() {
          child.kill("SIGTERM");
        },
      });

      child.stdout.on("data", (chunk: Buffer) => {
        if (headersParsed) {
          bodyController?.enqueue(new Uint8Array(chunk));
          return;
        }

        // Accumulate until we find \r\n\r\n header separator
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const separatorIdx = headerBuf.indexOf("\r\n\r\n");
        if (separatorIdx === -1) return;

        headersParsed = true;
        clearTimeout(headerTimer);
        const headerBlock = headerBuf.subarray(0, separatorIdx).toString("utf-8");
        const remaining = headerBuf.subarray(separatorIdx + 4);

        // Parse status and headers
        const { status, headers: parsedHeaders, setCookieHeaders } = parseHeaderDump(headerBlock);

        // Push remaining data (body after separator) into stream
        if (remaining.length > 0) {
          bodyController?.enqueue(new Uint8Array(remaining));
        }

        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }

        resolve({
          status,
          headers: parsedHeaders,
          body: bodyStream,
          setCookieHeaders,
        });
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(headerTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (!headersParsed) {
          reject(new CodexApiError(0, `curl exited with code ${code}: ${stderrBuf}`));
        }
        bodyController?.close();
      });

      child.on("error", (err) => {
        clearTimeout(headerTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(new CodexApiError(0, `curl spawn error: ${err.message}`));
      });
    });
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
    // When using system curl (not curl-impersonate), downgrade Accept-Encoding
    // to encodings it can always decompress. curl-impersonate supports br/zstd.
    if (!isImpersonate()) {
      headers["Accept-Encoding"] = "gzip, deflate";
    }

    // Build curl args (Chrome TLS profile + proxy + request params)
    const args = [...getChromeTlsArgs(), ...getProxyArgs(), "-s", "--compressed", "--max-time", "15"];
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url);

    const body = await new Promise<string>((resolve, reject) => {
      execFile(resolveCurlBinary(), args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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
   * Uses curl subprocess for native TLS fingerprint.
   */
  async createResponse(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const config = getConfig();
    const baseUrl = config.api.base_url;
    const url = `${baseUrl}/codex/responses`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    headers["Accept"] = "text/event-stream";

    const timeout = config.api.timeout_seconds;

    const curlRes = await this.curlPost(url, headers, JSON.stringify(request), signal, timeout);

    // Capture cookies
    this.captureCookiesFromCurl(curlRes.setCookieHeaders);

    if (curlRes.status < 200 || curlRes.status >= 300) {
      // Read the body for error details (P0-3: cap at 1MB to prevent memory spikes)
      const MAX_ERROR_BODY = 1024 * 1024; // 1MB
      const reader = curlRes.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize <= MAX_ERROR_BODY) {
          chunks.push(value);
        } else {
          // Truncate: push only the part that fits
          const overshoot = totalSize - MAX_ERROR_BODY;
          if (value.byteLength > overshoot) {
            chunks.push(value.subarray(0, value.byteLength - overshoot));
          }
          reader.cancel();
          break;
        }
      }
      const errorBody = Buffer.concat(chunks).toString("utf-8");
      throw new CodexApiError(curlRes.status, errorBody);
    }

    return new Response(curlRes.body, {
      status: curlRes.status,
      headers: curlRes.headers,
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

/** Parse the HTTP response header block from curl -i output. */
function parseHeaderDump(headerBlock: string): {
  status: number;
  headers: Headers;
  setCookieHeaders: string[];
} {
  const lines = headerBlock.split("\r\n");
  let status = 0;
  const headers = new Headers();
  const setCookieHeaders: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      // Status line: HTTP/1.1 200 OK
      const match = line.match(/^HTTP\/[\d.]+ (\d+)/);
      if (match) status = parseInt(match[1], 10);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value);
    }
    headers.append(key, value);
  }

  return { status, headers, setCookieHeaders };
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
