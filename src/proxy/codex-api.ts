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
import { createWebSocketResponse, type WsCreateRequest } from "./ws-transport.js";
import { parseSSEBlock, parseSSEStream } from "./codex-sse.js";
import { fetchUsage } from "./codex-usage.js";
import { fetchModels, probeEndpoint as probeEndpointFn } from "./codex-models.js";
import type { CookieJar } from "./cookie-jar.js";
import type { BackendModelEntry } from "../models/model-store.js";

// Re-export types from codex-types.ts for backward compatibility
export type {
  CodexResponsesRequest,
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
  type CodexResponsesRequest,
  type CodexSSEEvent,
  type CodexUsageResponse,
} from "./codex-types.js";

export class CodexApi {
  private token: string;
  private accountId: string | null;
  private cookieJar: CookieJar | null;
  private entryId: string | null;
  private proxyUrl: string | null | undefined;

  constructor(
    token: string,
    accountId: string | null,
    cookieJar?: CookieJar | null,
    entryId?: string | null,
    proxyUrl?: string | null,
  ) {
    this.token = token;
    this.accountId = accountId;
    this.cookieJar = cookieJar ?? null;
    this.entryId = entryId ?? null;
    this.proxyUrl = proxyUrl;
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
   * Falls back to HTTP SSE if WebSocket fails.
   */
  async createResponse(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (request.useWebSocket) {
      try {
        return await this.createResponseViaWebSocket(request, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
  ): Promise<Response> {
    const config = getConfig();
    const baseUrl = config.api.base_url;
    const wsUrl = baseUrl.replace(/^https?:/, "wss:") + "/codex/responses";

    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";

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

    return createWebSocketResponse(wsUrl, headers, wsRequest, signal, this.proxyUrl);
  }

  /**
   * Create a response via HTTP SSE (default transport).
   * Uses curl-impersonate for TLS fingerprinting.
   * No wall-clock timeout — header timeout + AbortSignal provide protection.
   */
  private async createResponseViaHttp(
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
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";

    const { service_tier: _st, previous_response_id: _pid, useWebSocket: _ws, ...bodyFields } = request;
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
   * Parse SSE stream from a Codex Responses API response.
   * Delegates to the standalone parseSSEStream() function.
   */
  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* parseSSEStream(response);
  }
}

// Re-export CodexApiError for backward compatibility
export { CodexApiError } from "./codex-types.js";
