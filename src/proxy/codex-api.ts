/**
 * CodexApi — client for the Codex Responses API.
 *
 * Endpoint: POST /backend-api/codex/responses
 * This is the API the Codex CLI actually uses.
 * It requires: instructions, store: false, stream: true.
 *
 * All upstream requests go through the TLS transport layer
 * (native rustls transport).
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import {
  buildHeaders,
  buildHeadersWithContentType,
} from "../fingerprint/manager.js";
import { createWebSocketResponse, type WsCreateRequest } from "./ws-transport.js";
import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { parseSSEBlock, parseSSEStream } from "./codex-sse.js";
import { fetchUsage } from "./codex-usage.js";
import { fetchModels, probeEndpoint as probeEndpointFn } from "./codex-models.js";
import type { CookieJar } from "./cookie-jar.js";
import type { BackendModelEntry } from "../models/model-store.js";

// Re-export types from codex-types.ts for backward compatibility
export type {
  CodexResponsesRequest,
  CodexCompactRequest,
  CodexCompactResponse,
  CodexContentPart,
  CodexInputItem,
  CodexSSEEvent,
  CodexUsageRateWindow,
  CodexUsageRateLimit,
  CodexUsageResponse,
} from "./codex-types.js";

// Re-export SSE utilities for consumers that used them via CodexApi
export { parseSSEBlock, parseSSEStream } from "./codex-sse.js";

import {
  CodexApiError,
  PreviousResponseWebSocketError,
  type CodexResponsesRequest,
  type CodexCompactRequest,
  type CodexCompactResponse,
  type CodexSSEEvent,
  type CodexUsageResponse,
} from "./codex-types.js";

export class CodexApi {
  readonly tag = "codex" as const;

  private token: string;
  private accountId: string | null;
  private cookieJar: CookieJar | null;
  private entryId: string | null;
  private proxyUrl: string | null | undefined;
  private baseUrl: string | undefined;
  private transport: TlsTransport | undefined;

  constructor(
    token: string,
    accountId: string | null,
    cookieJar?: CookieJar | null,
    entryId?: string | null,
    proxyUrl?: string | null,
    baseUrl?: string,
    transport?: TlsTransport,
  ) {
    this.token = token;
    this.accountId = accountId;
    this.cookieJar = cookieJar ?? null;
    this.entryId = entryId ?? null;
    this.proxyUrl = proxyUrl;
    this.baseUrl = baseUrl;
    this.transport = transport;
  }

  private resolveBaseUrl(): string {
    return this.baseUrl ?? getConfig().api.base_url;
  }

  private resolveTransport(): TlsTransport {
    return this.transport ?? getTransport();
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

  /** Query official Codex usage/quota. Delegates to standalone fetchUsage(). */
  async getUsage(): Promise<CodexUsageResponse> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return fetchUsage(headers, this.proxyUrl);
  }

  /**
   * Warmup request: GET /codex/usage with cookie capture.
   * Establishes session cookies (cf_clearance, __cf_bm, etc.) so subsequent
   * API requests look like a continuous session rather than a cold start.
   * Returns usage data if successful, null on any error.
   */
  async warmup(): Promise<CodexUsageResponse | null> {
    const config = getConfig();
    const transport = this.resolveTransport();
    const url = `${config.api.base_url}/codex/usage`;
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["Accept"] = "application/json";
    if (!transport.isImpersonate()) {
      headers["Accept-Encoding"] = "gzip, deflate";
    }

    try {
      let body: string;
      if (transport.getWithCookies) {
        const result = await transport.getWithCookies(url, headers, 15, this.proxyUrl);
        this.captureCookies(result.setCookieHeaders);
        body = result.body;
      } else {
        const result = await transport.get(url, headers, 15, this.proxyUrl);
        body = result.body;
      }
      const parsed = JSON.parse(body) as CodexUsageResponse;
      return parsed.rate_limit ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Fetch available models from the Codex backend. Probes known endpoints; returns null if none respond. */
  async getModels(): Promise<BackendModelEntry[] | null> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return fetchModels(headers, this.proxyUrl);
  }

  /** Probe a backend endpoint and return raw JSON (for debug). */
  async probeEndpoint(path: string): Promise<Record<string, unknown> | null> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return probeEndpointFn(path, headers, this.proxyUrl);
  }

  /**
   * Create a response (streaming).
   * Routes to WebSocket when previous_response_id is present (HTTP SSE doesn't support it).
   * 仅当不依赖 previous_response_id 时，WebSocket 失败后才降级到 HTTP SSE。
   */
  async createResponse(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
  ): Promise<Response> {
    if (request.useWebSocket) {
      try {
        return await this.createResponseViaWebSocket(request, signal, onRateLimits);
      } catch (err) {
        // Real upstream API errors classified by ws-transport (e.g.
        // usage_limit_reached → CodexApiError(429)) must reach the
        // proxy-handler's rotation flow on the SAME account, not retry
        // via HTTP — HTTP would just hit the same quota.
        if (err instanceof CodexApiError) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (request.previous_response_id) {
          console.warn(
            `[CodexApi] WebSocket 失败（${msg}），previous_response_id 不能安全降级到 HTTP SSE`,
          );
          throw new PreviousResponseWebSocketError(msg);
        }
        console.warn(`[CodexApi] WebSocket failed (${msg}), falling back to HTTP SSE`);
        const { previous_response_id: _, useWebSocket: _ws, ...httpRequest } = request;
        return this.createResponseViaHttp(httpRequest as CodexResponsesRequest, signal);
      }
    }
    return this.createResponseViaHttp(request, signal);
  }

  /**
   * Create a response via WebSocket (for previous_response_id support).
   * Returns a Response with SSE-formatted body, compatible with parseStream().
   * No Content-Type header — WebSocket upgrade handles auth via same headers.
   */
  private async createResponseViaWebSocket(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
  ): Promise<Response> {
    const baseUrl = this.resolveBaseUrl();
    const wsUrl = baseUrl.replace(/^https?:/, "wss:") + "/codex/responses";

    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();
    if (request.turnState) headers["x-codex-turn-state"] = request.turnState;

    const wsRequest: WsCreateRequest = {
      type: "response.create",
      model: request.model,
      instructions: request.instructions ?? "",
      input: request.input,
    };
    if (request.previous_response_id) {
      wsRequest.previous_response_id = request.previous_response_id;
    }
    if (request.reasoning) wsRequest.reasoning = request.reasoning;
    if (request.tools?.length) wsRequest.tools = request.tools;
    if (request.tool_choice) wsRequest.tool_choice = request.tool_choice;
    if (request.text) wsRequest.text = request.text;
    // service_tier is stripped — Codex backend rejects it ("Unsupported service_tier")
    if (request.prompt_cache_key) wsRequest.prompt_cache_key = request.prompt_cache_key;
    if (request.include?.length) wsRequest.include = request.include;

    return createWebSocketResponse(wsUrl, headers, wsRequest, signal, this.proxyUrl, onRateLimits);
  }

  /**
   * Create a response via HTTP SSE (default transport).
   * No wall-clock timeout — header timeout + AbortSignal provide protection.
   */
  private async createResponseViaHttp(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const transport = this.resolveTransport();
    const baseUrl = this.resolveBaseUrl();
    const url = `${baseUrl}/codex/responses`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    headers["Accept"] = "text/event-stream";
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();
    if (request.turnState) headers["x-codex-turn-state"] = request.turnState;

    const { previous_response_id: _pid, useWebSocket: _ws, turnState: _ts, service_tier: _st, ...bodyFields } = request;
    const body = JSON.stringify(bodyFields);

    let transportRes;
    try {
      transportRes = await transport.post(url, headers, body, signal, undefined, this.proxyUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, msg);
    }

    this.captureCookies(transportRes.setCookieHeaders);

    if (transportRes.status < 200 || transportRes.status >= 300) {
      const MAX_ERROR_BODY = 1024 * 1024;
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
   * Compact conversation history (non-streaming JSON).
   * POST /codex/responses/compact → { output: ResponseItem[] }.
   * codex-rs uses this for server-side context compaction (session.execute, not stream).
   */
  async createCompactResponse(
    request: CodexCompactRequest,
    signal?: AbortSignal,
  ): Promise<CodexCompactResponse> {
    const transport = this.resolveTransport();
    const baseUrl = this.resolveBaseUrl();
    const url = `${baseUrl}/codex/responses/compact`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    // No "Accept: text/event-stream" — compact returns plain JSON
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();

    const body = JSON.stringify(request);

    let transportRes;
    try {
      transportRes = await transport.post(url, headers, body, signal, undefined, this.proxyUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, msg);
    }

    this.captureCookies(transportRes.setCookieHeaders);

    // Read the full response body (non-streaming)
    const reader = transportRes.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const responseBody = Buffer.concat(chunks).toString("utf-8");

    if (transportRes.status < 200 || transportRes.status >= 300) {
      throw new CodexApiError(transportRes.status, responseBody);
    }

    try {
      return JSON.parse(responseBody) as CodexCompactResponse;
    } catch {
      throw new CodexApiError(502, `Compact response is not valid JSON: ${responseBody.slice(0, 200)}`);
    }
  }

  /**
   * Parse SSE stream from a Codex Responses API response.
   * Delegates to the standalone parseSSEStream() function.
   */
  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* parseSSEStream(response);
  }
}

// Re-export CodexApiError for backward compatibility
export { CodexApiError, PreviousResponseWebSocketError } from "./codex-types.js";
