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
 * The `ws` package is loaded lazily via dynamic import so its heavy
 * CJS init (Receiver/Sender/PerMessageDeflate) is deferred until the
 * WS path is actually exercised. Note: esbuild still bundles ws into
 * the ESM server bundle; that bundling is what makes the
 * `createRequire` banner in packages/electron/electron/build.mjs
 * load-bearing — without it, ws's `require("events")` etc. throw
 * `Dynamic require of "X" is not supported` at runtime.
 */

import type { CodexInputItem } from "./codex-api.js";
import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { parseRateLimitsEvent } from "./rate-limit-headers.js";
import { CodexApiError } from "./codex-types.js";
import { getProxyUrl } from "../tls/proxy.js";
import {
  PersistentWs,
  WsReusedConnectionError,
  type PersistentWsHooks,
  type WsConnectionPool,
} from "./ws-pool.js";

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
  // 400 — stale previous_response_id (account doesn't recognise it; let
  // proxy-handler strip the ID and retry on the same account)
  previous_response_not_found: 400,
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

function isTerminalWsEvent(type: string): boolean {
  return type === "response.completed" || type === "response.failed" || type === "error";
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

/**
 * Public alias of `getWS` — exposes the lazy ws loader so the Electron
 * bundle smoke test can force ws's CJS factory to run without spinning
 * up the full server. Re-exported via packages/electron/src/electron-entry.ts;
 * consumed by packages/electron/__tests__/build.test.ts.
 */
export const loadWebSocketModule = getWS;

/** Flat WebSocket message format expected by the Codex backend. */
export interface WsCreateRequest {
  type: "response.create";
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  previous_response_id?: string;
  reasoning?: { effort?: string; summary?: string };
  tools?: unknown[];
  tool_choice?: string | { type: string; name?: string };
  parallel_tool_calls?: boolean;
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  service_tier?: string;
  prompt_cache_key?: string;
  client_metadata?: Record<string, string>;
  include?: string[];
}

/** Optional pool routing context. When provided, `createWebSocketResponse`
 *  tries to reuse a pooled WS for `(entryId, poolKey)` before falling back
 *  to opening a fresh one-shot connection. */
export interface WsPoolContext {
  pool: WsConnectionPool;
  poolKey: string;
  entryId: string;
  /** Optional observer fired once with the pool's dispatch decision. Useful
   *  for logging without coupling the caller to the pool's internal state. */
  onDecision?: (decision: WsDispatchDecision) => void;
}

export type WsDispatchDecision =
  | { kind: "reuse"; wsId: string }
  | { kind: "new"; wsId: string }
  | { kind: "bypass"; reason: string }
  | { kind: "retry-after-stale-reuse"; wsId: string };

async function buildWsConstructorOpts(
  WS: typeof import("ws").default,
  headers: Record<string, string>,
  proxyUrl: string | null | undefined,
): Promise<ConstructorParameters<typeof WS>[2]> {
  const wsOpts: ConstructorParameters<typeof WS>[2] = { headers };
  // Mirror native transport proxy semantics:
  // undefined = global default, null = explicit direct, string = specific proxy.
  const effectiveProxyUrl =
    proxyUrl === undefined ? getProxyUrl() : proxyUrl;
  if (effectiveProxyUrl) {
    let agent = _agentCache.get(effectiveProxyUrl);
    if (!agent) {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new HttpsProxyAgent(effectiveProxyUrl);
      _agentCache.set(effectiveProxyUrl, agent);
    }
    wsOpts.agent = agent;
  }
  return wsOpts;
}

/** Factory used by the pool to construct a brand-new persistent connection.
 *  Connects + waits for OPEN before returning so callers can immediately
 *  send. The PersistentWs is constructed up-front so its `upgrade` listener
 *  catches the initial response headers (which carry rate-limit data). */
async function createPersistentWsConnection(opts: {
  wsUrl: string;
  headers: Record<string, string>;
  proxyUrl: string | null | undefined;
  entryId: string;
  poolKey: string;
  hooks: PersistentWsHooks;
}): Promise<PersistentWs> {
  const WS = await getWS();
  const wsOpts = await buildWsConstructorOpts(WS, opts.headers, opts.proxyUrl);
  const ws = new WS(opts.wsUrl, wsOpts);

  // Construct PersistentWs first so its upgrade/error/close handlers attach
  // before the WebSocket handshake completes.
  const persistent = new PersistentWs({
    ws,
    entryId: opts.entryId,
    poolKey: opts.poolKey,
    hooks: opts.hooks,
  });

  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === ws.OPEN) {
      resolve();
      return;
    }
    const cleanup = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onErr);
      ws.removeListener("close", onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onErr = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error("WebSocket closed before open")); };
    ws.once("open", onOpen);
    ws.once("error", onErr);
    ws.once("close", onClose);
  });

  return persistent;
}

/**
 * Open a WebSocket to the Codex backend, send `response.create`,
 * and return a Response whose body is an SSE-formatted ReadableStream.
 *
 * The SSE format matches what parseStream() expects:
 *   event: <type>\ndata: <json>\n\n
 *
 * When `poolCtx` is provided the call first tries to reuse a pooled WS for
 * `(entryId, poolKey)`; on a `WsReusedConnectionError` (stale-reuse failure)
 * it falls back to a fresh one-shot connection exactly once.
 */
export async function createWebSocketResponse(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal?: AbortSignal,
  proxyUrl?: string | null,
  onRateLimits?: (rl: ParsedRateLimit) => void,
  poolCtx?: WsPoolContext,
): Promise<Response> {
  if (poolCtx) {
    try {
      const acquired = await poolCtx.pool.acquire(
        poolCtx.entryId,
        poolCtx.poolKey,
        (deps) =>
          createPersistentWsConnection({
            wsUrl,
            headers,
            proxyUrl,
            entryId: deps.entryId,
            poolKey: deps.poolKey,
            hooks: deps.hooks,
          }),
      );
      if ("ws" in acquired) {
        poolCtx.onDecision?.({
          kind: acquired.reused ? "reuse" : "new",
          wsId: acquired.ws.id,
        });
        try {
          return await acquired.ws.send({ request, signal, onRateLimits, reused: acquired.reused });
        } catch (err) {
          if (err instanceof WsReusedConnectionError) {
            // Stale-reuse: open a fresh one-shot WS for this single request.
            // The pool's onDead hook has already evicted the dead entry.
            poolCtx.onDecision?.({ kind: "retry-after-stale-reuse", wsId: acquired.ws.id });
            return openOneShotWs(wsUrl, headers, request, signal, proxyUrl, onRateLimits);
          }
          throw err;
        }
      }
      // Bypass (busy / cap / dead / no_key / disabled) → fall through to one-shot.
      poolCtx.onDecision?.({ kind: "bypass", reason: acquired.bypass });
    } catch (err) {
      // Pool itself failed (e.g. factory could not connect). Don't punish the
      // caller — fall back to the legacy one-shot path. The error is still
      // visible in the one-shot path if the underlying issue persists.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ws-pool] acquire failed, using one-shot fallback: ${msg}`);
      poolCtx.onDecision?.({ kind: "bypass", reason: "factory_error" });
    }
  }

  return openOneShotWs(wsUrl, headers, request, signal, proxyUrl, onRateLimits);
}

async function openOneShotWs(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal: AbortSignal | undefined,
  proxyUrl: string | null | undefined,
  onRateLimits: ((rl: ParsedRateLimit) => void) | undefined,
): Promise<Response> {
  const WS = await getWS();
  const wsOpts = await buildWsConstructorOpts(WS, headers, proxyUrl);

  return new Promise<Response>((resolve, reject) => {
    const ws = new WS(wsUrl, wsOpts);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    let earlyDecisionMade = false;
    let sawTerminalEvent = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let ignoreClosedBeforeOpenError = false;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        ws.close(1000, "stream cancelled");
      },
    });

    function cleanupTimers() {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
    }

    function markLocalConnectingClose() {
      if (ws.readyState === 0) {
        ignoreClosedBeforeOpenError = true;
      }
    }

    function onAbort() {
      cleanupTimers();
      const hadEarlyDecision = earlyDecisionMade;
      if (!hadEarlyDecision) {
        earlyDecisionMade = true;
      }
      markLocalConnectingClose();
      try { ws.close(1000, "aborted"); } catch { /* already closing */ }
      if (!hadEarlyDecision) {
        reject(new Error("aborted"));
      } else {
        errorStream(new Error("aborted"));
      }
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    function closeStream() {
      cleanupTimers();
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    }

    function errorStream(err: Error) {
      cleanupTimers();
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.error(err); } catch { /* already closed */ }
      }
    }

    // Capture upgrade response headers (contains x-codex-* rate limit data)
    let upgradeHeaders: Record<string, string | string[]> = {};
    ws.on("upgrade", (response: { headers: Record<string, string | string[]> }) => {
      upgradeHeaders = response.headers;
    });

    function buildResponse(): Response {
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      for (const [key, value] of Array.from(Object.entries(upgradeHeaders))) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v != null) responseHeaders.set(key, v);
      }
      return new Response(stream, { status: 200, headers: responseHeaders });
    }

    // Setup all event listeners first
    ws.on("open", () => {
      console.log(`[WS-Open] 🟢 WebSocket successfully opened for request. wsUrl: ${wsUrl}`);
      ignoreClosedBeforeOpenError = false;
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }
      ws.send(JSON.stringify(request));
      pingTimer = setInterval(() => {
        try { ws.ping(); } catch { /* ws already closed */ }
      }, 25_000);
    });

    ws.on("message", (data: Buffer | string) => {
      if (streamClosed) return;
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      console.log(`[WS-Message] 📥 Frame received. Raw length: ${raw.length}, snippet: ${raw.slice(0, 120)}`);

      let msg: Record<string, unknown> | null = null;
      let type = "unknown";
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
        type = typeof msg.type === "string" ? msg.type : "unknown";
      } catch {
        // Non-JSON message — handled below as raw data.
      }

      const isImageGen = request.model?.includes("image");
      const isRateLimit = msg && type === "codex.rate_limits";

      if (isRateLimit && onRateLimits) {
        const rl = parseRateLimitsEvent(msg!);
        if (rl) onRateLimits(rl);
      }

      if (!earlyDecisionMade) {
        if (isRateLimit && !isImageGen) {
          // Do not flip earlyDecisionMade on rate_limits for chat models,
          // so we can still catch the upcoming `error` frame as an HTTP rejection.
        } else {
          earlyDecisionMade = true;
          if (msg && !isRateLimit) {
            const classified = classifyWsErrorEvent(msg);
            if (classified) {
              cleanupTimers();
              reject(new CodexApiError(classified.status, JSON.stringify(msg)));
              try { ws.close(1000, "early upstream error"); } catch { /* already closing */ }
              return;
            }
          }
          resolve(buildResponse());
        }
      }

      if (isRateLimit && onRateLimits) {
        return;
      }
      if (msg) {
        const sse = `event: ${type}\ndata: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));

        if (isTerminalWsEvent(type)) {
          sawTerminalEvent = true;
          queueMicrotask(() => {
            closeStream();
            ws.close(1000);
          });
        }
      } else {
        const sse = `data: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));
      }
    });

    ws.on("error", (err: Error) => {
      if (
        ignoreClosedBeforeOpenError &&
        err.message === "WebSocket was closed before the connection was established"
      ) {
        return;
      }
      console.error(`[WS-Error] ❌ WebSocket error for request:`, err.message);
      cleanupTimers();
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        reject(err);
      } else {
        errorStream(err);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason && reason.length ? reason.toString("utf-8") : "";
      console.log(`[WS-Close] 🔴 WebSocket closed. Code: ${code}, Reason: ${reasonStr}`);
      cleanupTimers();
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        reject(new Error(
          `WebSocket closed before any data: code=${code}` +
            (reasonStr ? ` reason=${reasonStr}` : ""),
        ));
        return;
      }
      if (earlyDecisionMade && !sawTerminalEvent) {
        errorStream(new Error(
          `WebSocket closed before terminal event: code=${code}` +
            (reasonStr ? ` reason=${reasonStr}` : ""),
        ));
        return;
      }
      closeStream();
    });

    // Start timers and process signal
    openTimer = setTimeout(() => {
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        cleanupTimers();
        markLocalConnectingClose();
        try { ws.close(1000, "open timeout"); } catch { /* already closing */ }
        reject(new Error("WebSocket open timeout (20s)"));
      }
    }, 20_000);
  });
}
