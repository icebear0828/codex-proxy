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
import { CodexApiError } from "./codex-types.js";

/**
 * Map an upstream WS terminal error frame (`type: "error"` or
 * `type: "response.failed"`) to an HTTP-equivalent status so that the
 * proxy-handler's existing CodexApiError rotation flow can take over.
 *
 * Returns null for events we don't want to rotate on (genuine model
 * errors, validation errors, etc.) — those keep the SSE pass-through
 * behavior so the client sees the real reason.
 *
 * Why exact-match: a substring rule like `includes("rate_limit")` would
 * also match codes such as `soft_rate_limit_warning` and incorrectly
 * trigger account rotation. We allowlist concrete codes and fall through
 * for everything else (unknown codes stream as SSE — safer default).
 */
const ROTATABLE_ERROR_CODES: Readonly<Record<string, number>> = {
  // 429 — weekly/primary cap
  usage_limit_reached: 429,
  rate_limit_exceeded: 429,
  rate_limit_reached: 429,
  // 402 — plan/credit exhausted
  quota_exhausted: 402,
  payment_required: 402,
  // 401 — credential rejected upstream
  unauthorized: 401,
  token_invalid: 401,
  token_expired: 401,
  account_deactivated: 401,
  // 403 — account banned
  forbidden: 403,
  account_banned: 403,
  banned: 403,
};

function classifyWsErrorEvent(msg: Record<string, unknown>): { status: number } | null {
  const type = typeof msg.type === "string" ? msg.type : "";
  if (type !== "error" && type !== "response.failed") return null;
  const errorObj = typeof msg.error === "object" && msg.error !== null
    ? (msg.error as Record<string, unknown>)
    : null;
  if (!errorObj) return null;
  const codeRaw =
    (typeof errorObj.code === "string" ? errorObj.code : null) ??
    (typeof errorObj.type === "string" ? errorObj.type : null) ??
    "";
  const status = ROTATABLE_ERROR_CODES[codeRaw.toLowerCase()];
  return status ? { status } : null;
}

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
    // Flips the first time we either resolve(Response) or reject(...).
    // Internal `codex.rate_limits` frames do NOT flip this — we keep waiting
    // for a real first frame so we can detect early upstream errors and
    // route them through the existing CodexApiError → rotation path.
    let earlyDecisionMade = false;

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
      try { ws.close(1000, "aborted"); } catch { /* already closing */ }
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
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

    function buildResponse(): Response {
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      for (const [key, value] of Object.entries(upgradeHeaders)) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v != null) responseHeaders.set(key, v);
      }
      return new Response(stream, { status: 200, headers: responseHeaders });
    }

    ws.on("open", () => {
      ws.send(JSON.stringify(request));
      // resolve() is deferred until the first non-internal frame arrives in
      // ws.on("message"). This lets us classify early upstream errors (e.g.
      // usage_limit_reached) and reject with a CodexApiError so the
      // proxy-handler's existing rotation flow takes over instead of the
      // error being passed through mid-stream to the client.
    });

    ws.on("message", (data: Buffer | string) => {
      if (streamClosed) return;
      const raw = typeof data === "string" ? data : data.toString("utf-8");

      let msg: Record<string, unknown> | null = null;
      let type = "unknown";
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
        type = typeof msg.type === "string" ? msg.type : "unknown";
      } catch {
        // Non-JSON message — handled below as raw data.
      }

      // Internal rate-limit frames are observed via `onRateLimits` but not
      // streamed, and they don't flip the early-decision flag — we keep
      // waiting for a real frame so we can detect early upstream errors.
      // If no callback is provided (test-only path), fall through and
      // forward the frame as SSE like any other event.
      if (msg && type === "codex.rate_limits" && onRateLimits) {
        const rl = parseRateLimitsEvent(msg);
        if (rl) onRateLimits(rl);
        return;
      }

      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        if (msg) {
          const classified = classifyWsErrorEvent(msg);
          if (classified) {
            reject(new CodexApiError(classified.status, JSON.stringify(msg)));
            try { ws.close(1000, "early upstream error"); } catch { /* already closing */ }
            return;
          }
        }
        resolve(buildResponse());
        // fall through to enqueue this first frame
      }

      if (msg) {
        // Re-encode as SSE: event: <type>\ndata: <full json>\n\n
        const sse = `event: ${type}\ndata: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));

        // Close stream after response.completed, response.failed, or error
        if (type === "response.completed" || type === "response.failed" || type === "error") {
          queueMicrotask(() => {
            closeStream();
            ws.close(1000);
          });
        }
      } else {
        // Non-JSON message — emit as raw data
        const sse = `data: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));
      }
    });

    ws.on("error", (err: Error) => {
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        reject(err);
      } else {
        errorStream(err);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        const reasonStr = reason && reason.length ? reason.toString("utf-8") : "";
        reject(new Error(
          `WebSocket closed before any data: code=${code}` +
            (reasonStr ? ` reason=${reasonStr}` : ""),
        ));
      }
      closeStream();
    });
  });
}
