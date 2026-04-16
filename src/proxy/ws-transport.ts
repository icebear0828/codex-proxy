/**
 * WebSocket transport for the Codex Responses API.
 *
 * Opens a WebSocket to the backend, sends a `response.create` message,
 * and wraps incoming JSON messages into an SSE-formatted ReadableStream.
 * This lets parseStream() and all downstream consumers work identically
 * regardless of whether HTTP SSE or WebSocket was used.
 *
 * Used when `previous_response_id` is present — HTTP SSE does not support it.
 *
 * The `ws` package is loaded lazily via dynamic import to avoid
 * "Dynamic require of 'events' is not supported" errors when the
 * backend is bundled as ESM for Electron (esbuild cannot convert
 * ws's CJS require chain to ESM statics).
 */

import type { CodexInputItem } from "./codex-api.js";
import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { parseRateLimitsEvent } from "./rate-limit-headers.js";

/** Cached ws module — loaded once on first use. */
let _WS: typeof import("ws").default | undefined;

/** Cached proxy agents keyed by URL — avoids creating a new TCP connection per request. */
const _agentCache = new Map<string, InstanceType<typeof import("https-proxy-agent").HttpsProxyAgent>>();

/** Lazily load the `ws` package. */
async function getWS(): Promise<typeof import("ws").default> {
  if (!_WS) {
    const mod = await import("ws");
    _WS = mod.default;
  }
  return _WS;
}

/** Flat WebSocket message format expected by the Codex backend. */
export interface WsCreateRequest {
  type: "response.create";
  model: string;
  instructions: string;
  input: CodexInputItem[];
  previous_response_id?: string;
  reasoning?: { effort?: string; summary?: string };
  tools?: unknown[];
  tool_choice?: string | { type: string; name?: string };
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  prompt_cache_key?: string;
  include?: string[];
  // NOTE: `store` and `stream` are intentionally omitted.
  // The backend defaults to storing via WebSocket and always streams.
}

/**
 * Open a WebSocket to the Codex backend, send `response.create`,
 * and return a Response whose body is an SSE-formatted ReadableStream.
 *
 * The SSE format matches what parseStream() expects:
 *   event: <type>\ndata: <json>\n\n
 */
export async function createWebSocketResponse(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal?: AbortSignal,
  proxyUrl?: string | null,
  onRateLimits?: (rl: ParsedRateLimit) => void,
): Promise<Response> {
  const WS = await getWS();

  // Lazy-import proxy agent only when needed; cache by URL to reuse connections
  const wsOpts: ConstructorParameters<typeof WS>[2] = { headers };
  if (proxyUrl) {
    let agent = _agentCache.get(proxyUrl);
    if (!agent) {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new HttpsProxyAgent(proxyUrl);
      _agentCache.set(proxyUrl, agent);
    }
    wsOpts.agent = agent;
  }

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before WebSocket connect"));
      return;
    }

    const ws = new WS(wsUrl, wsOpts);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    let connected = false;

    function closeStream() {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    }

    function errorStream(err: Error) {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.error(err); } catch { /* already closed */ }
      }
    }

    // Abort signal handling
    const onAbort = () => {
      ws.close(1000, "aborted");
      if (!connected) {
        reject(new Error("Aborted during WebSocket connect"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        ws.close(1000, "stream cancelled");
      },
    });

    // Capture upgrade response headers (contains x-codex-* rate limit data)
    let upgradeHeaders: Record<string, string | string[]> = {};
    ws.on("upgrade", (response: { headers: Record<string, string | string[]> }) => {
      upgradeHeaders = response.headers;
    });

    ws.on("open", () => {
      connected = true;
      ws.send(JSON.stringify(request));

      // Build response headers from WS upgrade headers
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      for (const [key, value] of Object.entries(upgradeHeaders)) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v != null) responseHeaders.set(key, v);
      }
      resolve(new Response(stream, { status: 200, headers: responseHeaders }));
    });

    ws.on("message", (data: Buffer | string) => {
      if (streamClosed) return;
      const raw = typeof data === "string" ? data : data.toString("utf-8");

      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const type = (msg.type as string) ?? "unknown";

        // Extract rate-limit data from codex.rate_limits event (WS-only)
        if (type === "codex.rate_limits" && onRateLimits) {
          const rl = parseRateLimitsEvent(msg);
          if (rl) onRateLimits(rl);
          // Don't forward internal rate-limit events to downstream clients
          return;
        }

        // Re-encode as SSE: event: <type>\ndata: <full json>\n\n
        const sse = `event: ${type}\ndata: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));

        // Close stream after response.completed, response.failed, or error
        if (type === "response.completed" || type === "response.failed" || type === "error") {
          // Let the SSE chunk flush, then close
          queueMicrotask(() => {
            closeStream();
            ws.close(1000);
          });
        }
      } catch {
        // Non-JSON message — emit as raw data
        const sse = `data: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));
      }
    });

    ws.on("error", (err: Error) => {
      signal?.removeEventListener("abort", onAbort);
      if (!connected) {
        reject(err);
      } else {
        errorStream(err);
      }
    });

    ws.on("close", (_code: number, _reason: Buffer) => {
      signal?.removeEventListener("abort", onAbort);
      closeStream();
    });
  });
}
