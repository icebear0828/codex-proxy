/**
 * WebSocket connection pool for upstream Codex Responses API.
 *
 * ## Why
 *
 * OpenAI's WebSocket gateway routes each new connection to a backend instance
 * via load-balancer hashing of the connection ID. Within a connection, all
 * requests stay on the same backend, which keeps the prompt cache warm.
 * Across connections, the LB ignores `prompt_cache_key`, `previous_response_id`,
 * and `x-codex-installation-id` as routing hints — so re-opening a fresh WS
 * for every turn (which the proxy used to do) randomly bounces between
 * backend instances and produces erratic 5%~99% cache hit rates.
 *
 * Real Codex CLI sidesteps this by maintaining `WebsocketSession.connection`
 * (codex-rs `core/src/client.rs:802`) and reusing it across turns until the
 * server-side 60-minute connection cap kicks in.
 *
 * This pool replicates that behavior: pin same `(entryId, conversationId)`
 * to the same physical WS for all turns, so the upstream LB pins us to the
 * same backend and prompt cache stays warm.
 *
 * ## Design
 *
 * - **Pool key**: `${entryId}:${conversationId}` — both stable across turns
 *   (entryId from `account-persistence.ts:57`, conversationId from
 *   `proxy-handler.ts:226`). Empty conversationId → don't pool.
 * - **Per-WS strict serial**: Codex protocol requires one in-flight at a
 *   time per WS (mirrors codex-rs's `last_response_rx` pattern). Pool busy
 *   → caller bypasses to `openOneShotWs` (no internal queue, no deadlock).
 * - **No idle TTL**: kept open until natural death (server close / TCP RST →
 *   immediate evict), `max_age_ms` (55 min, leaves 5 min margin under the
 *   server's 60 min hard cap), or account state change (refresh / banned /
 *   disabled / rate-limited → cascade evict via `evictByEntryId`).
 * - **Account slot decoupled**: WS lifecycle is independent of the
 *   account-pool acquire/release slot. `proxy-handler` releases the slot
 *   when the stream finishes; the WS stays in the pool for the next turn.
 *
 * ## Failure semantics
 *
 * - WS dies **before** first response frame on a reused connection →
 *   `WsReusedConnectionError` (caller may retry once with a fresh WS).
 * - WS dies **after** the first frame (mid-stream RST) → `controller.error()`
 *   on the live ReadableStream. Cannot retry — the client already saw
 *   partial data, must propagate the error.
 * - Caller `AbortSignal.abort()` → reject current send + immediately evict
 *   the WS (server may continue pushing tail frames that would corrupt the
 *   next reuser).
 */

import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { parseRateLimitsEvent } from "./rate-limit-headers.js";
import { CodexApiError } from "./codex-types.js";
import type { WsCreateRequest } from "./ws-transport.js";
import { randomUUID } from "crypto";

// ── Error types ────────────────────────────────────────────────────

/** Thrown when a *reused* pooled WS dies before producing the first response
 *  frame. The caller should retry once with a fresh non-pooled connection,
 *  since the failure was caused by stale state on the reused connection
 *  rather than by a real upstream/account issue. */
export class WsReusedConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsReusedConnectionError";
  }
}

// ── Internal types ─────────────────────────────────────────────────

interface InFlightSession {
  controller: ReadableStreamDefaultController<Uint8Array>;
  onRateLimits: ((rl: ParsedRateLimit) => void) | undefined;
  earlyDecisionMade: boolean;
  sawTerminalEvent: boolean;
  earlyMetadataChunks: Uint8Array[];
  /** Resolves the outer send() Promise with the SSE Response.
   *  Closes over the freshly-built ReadableStream so callers don't need to
   *  pass it back in. */
  resolveResponse: () => void;
  reject: (err: Error) => void;
  abortListener: (() => void) | null;
  signal: AbortSignal | undefined;
  streamClosed: boolean;
  responseStartTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Subset of the `ws` module's WebSocket interface that PersistentWs needs.
 *  Declared here to avoid pulling in the `ws` typedefs at module load (it's
 *  lazy-loaded). Real ws.WebSocket is structurally compatible. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  // Real ws.WebSocket.ping accepts (data?, mask?, callback?); we intentionally
  // narrow to no-arg since the keepalive use case never needs a payload.
  ping(): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "upgrade", listener: (response: { headers: Record<string, string | string[]> }) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  // ws emits "pong" when the peer replies to our ping(); used as a liveness
  // signal to detect silently-broken connections middlebox-side.
  on(event: "pong", listener: () => void): void;
}

const WS_OPEN = 1;

// Same allowlist as ws-transport.ts. Duplicated here intentionally so the
// pool module doesn't depend on the transport's internals (and vice versa).
const ROTATABLE_ERROR_CODES: Readonly<Record<string, number>> = {
  usage_limit_reached: 429,
  rate_limit_exceeded: 429,
  rate_limit_reached: 429,
  quota_exhausted: 402,
  payment_required: 402,
  unauthorized: 401,
  token_invalid: 401,
  token_expired: 401,
  account_deactivated: 401,
  forbidden: 403,
  account_banned: 403,
  banned: 403,
  previous_response_not_found: 400,
  websocket_connection_limit_reached: 503,
};

function classifyWsErrorEvent(msg: Record<string, unknown>): { status: number; code: string } | null {
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
  const lower = codeRaw.toLowerCase();
  const status = ROTATABLE_ERROR_CODES[lower];
  return status ? { status, code: lower } : null;
}

function isTerminalWsEvent(type: string): boolean {
  return type === "response.completed" || type === "response.failed" || type === "error";
}

function isEarlyMetadataWsEvent(type: string): boolean {
  return type === "response.created" ||
    type === "response.in_progress" ||
    type === "response.metadata" ||
    type === "codex.response.metadata";
}

function completedResponseId(msg: Record<string, unknown>, type: string): string | null {
  if (type !== "response.completed") return null;
  const response = typeof msg.response === "object" && msg.response !== null
    ? msg.response as Record<string, unknown>
    : null;
  const id = response?.id ?? msg.response_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// ── PersistentWs ───────────────────────────────────────────────────

export interface PersistentWsHooks {
  /** Called when this WS becomes unusable (close, error, eviction).
   *  The pool uses this to remove the entry and all response owners. */
  onDead(): void;
  /** Called only after a response.completed frame establishes the newest
   *  connection-local previous-response anchor. */
  onResponseCompleted?(responseId: string): void;
}

/** Default keepalive cadence. 25s sits comfortably under the typical 30-60s
 *  idle timeouts of upstream LBs / NAT middleboxes that have been observed to
 *  silently RST otherwise-healthy pooled WSes mid-session (close code 1006). */
export const DEFAULT_PING_INTERVAL_MS = 25_000;

/** Multiplier applied to pingIntervalMs when livenessTimeoutMs is omitted.
 *  2.5x means we tolerate one missed pong (network blip) but evict before a
 *  third would tick — at which point the connection is almost certainly dead
 *  and re-using it would cost a real-request cache miss. */
export const DEFAULT_LIVENESS_TIMEOUT_MULTIPLIER = 2.5;

/** Maximum time to wait for the first non-metadata response event. This keeps
 *  an upstream that sends only provisional metadata from occupying a pooled
 *  connection indefinitely. */
export const DEFAULT_WS_RESPONSE_START_TIMEOUT_MS = 180_000;

export class PersistentWs {
  readonly id: string;
  readonly entryId: string;
  readonly poolKey: string;

  private ws: WsLike;
  private busy = false;
  private currentSession: InFlightSession | null = null;
  private readonly createdAt: number;
  private readonly now: () => number;
  private pendingClose = false;
  private dead = false;
  private upgradeHeaders: Record<string, string | string[]> = {};
  private hooks: PersistentWsHooks;
  private readonly encoder = new TextEncoder();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** Last moment we received any signal from the peer (pong or data frame).
   *  Used by the keepalive tick to detect silently-broken connections that
   *  would otherwise eat a fresh-WS cache miss on the next real request. */
  private lastActivityAt: number;
  private readonly livenessTimeoutMs: number;

  constructor(opts: {
    ws: WsLike;
    entryId: string;
    poolKey: string;
    hooks: PersistentWsHooks;
    now?: () => number;
    /** 0 disables the keepalive timer. Omit to use {@link DEFAULT_PING_INTERVAL_MS}. */
    pingIntervalMs?: number;
    /** Max ms without any pong/message before the WS is treated as silently dead.
     *  0 disables the liveness check entirely. Omit to default to
     *  {@link DEFAULT_LIVENESS_TIMEOUT_MULTIPLIER} × pingIntervalMs. */
    livenessTimeoutMs?: number;
  }) {
    this.id = randomUUID().slice(0, 8);
    this.ws = opts.ws;
    this.entryId = opts.entryId;
    this.poolKey = opts.poolKey;
    this.hooks = opts.hooks;
    this.now = opts.now ?? Date.now;
    this.createdAt = this.now();
    this.lastActivityAt = this.createdAt;

    this.ws.on("upgrade", (response) => {
      this.upgradeHeaders = response.headers;
    });

    this.ws.on("message", (data) => {
      this.lastActivityAt = this.now();
      this.handleMessage(data);
    });

    this.ws.on("pong", () => {
      this.lastActivityAt = this.now();
    });

    this.ws.on("error", (err) => this.handleTransportError(err));

    this.ws.on("close", (code, reason) => this.handleClose(code, reason));

    const pingMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? Math.round(pingMs * DEFAULT_LIVENESS_TIMEOUT_MULTIPLIER);
    if (pingMs > 0) {
      this.pingTimer = setInterval(() => this.sendKeepalivePing(), pingMs);
      this.pingTimer.unref?.();
    }
  }

  private sendKeepalivePing(): void {
    // Keep pinging during in-flight requests too. Reasoning-heavy responses may
    // stay silent for 60-120s; without control frames, NAT/LB paths can drop an
    // otherwise healthy pooled connection with close code 1006.
    if (this.dead || this.ws.readyState !== WS_OPEN) return;
    // Liveness check: if the peer hasn't produced ANY signal (pong or message)
    // for too long, the connection is silently broken (middlebox dropped it
    // without sending FIN/RST). Evicting now beats eating a real-request cache
    // miss when the next acquire would otherwise reuse this dead-but-OPEN ws.
    if (this.livenessTimeoutMs > 0 && this.now() - this.lastActivityAt > this.livenessTimeoutMs) {
      this.markDead(`liveness timeout (no upstream activity for ${this.now() - this.lastActivityAt}ms)`);
      return;
    }
    try { this.ws.ping(); } catch { /* skip this tick; next interval will try again */ }
  }

  /** Atomic-ish acquire (single-threaded JS, so just a boolean check).
   *  Fails when busy / pendingClose / dead / not OPEN. */
  tryAcquire(): boolean {
    if (this.busy || this.pendingClose || this.dead) return false;
    if (this.ws.readyState !== WS_OPEN) return false;
    this.busy = true;
    return true;
  }

  isAlive(): boolean {
    return !this.dead && !this.pendingClose && this.ws.readyState === WS_OPEN;
  }

  isBusy(): boolean {
    return this.busy;
  }

  isExpired(maxAgeMs: number): boolean {
    return this.now() - this.createdAt > maxAgeMs;
  }

  /** Send `request` over this WS. Caller MUST have called tryAcquire() first.
   *
   *  - `reused = true` flag tells `send()` to throw `WsReusedConnectionError`
   *    on pre-response failures (instead of a generic Error), so the caller
   *    can distinguish "stale reuse" from "real upstream problem".
   *  - On terminal frame (response.completed/failed/error) the stream closes
   *    and busy is cleared, but the WS itself stays open for the next caller.
   */
  send(opts: {
    request: WsCreateRequest;
    signal: AbortSignal | undefined;
    onRateLimits: ((rl: ParsedRateLimit) => void) | undefined;
    reused: boolean;
    responseStartTimeoutMs?: number;
  }): Promise<Response> {
    if (!this.busy) {
      throw new Error("PersistentWs.send called without prior tryAcquire");
    }

    return new Promise<Response>((resolve, reject) => {
      if (opts.signal?.aborted) {
        this.busy = false;
        this.markDead("aborted before send");
        reject(new Error("Aborted before WebSocket send"));
        return;
      }

      const wrappedReject = (err: Error) => {
        if (opts.reused && !(err instanceof CodexApiError) && !(err instanceof WsReusedConnectionError)) {
          reject(new WsReusedConnectionError(err.message));
        } else {
          reject(err);
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.currentSession = {
            controller,
            onRateLimits: opts.onRateLimits,
            earlyDecisionMade: false,
            sawTerminalEvent: false,
            earlyMetadataChunks: [],
            resolveResponse: () => resolve(this.buildResponse(stream)),
            reject: wrappedReject,
            abortListener: null,
            signal: opts.signal,
            streamClosed: false,
            responseStartTimer: undefined,
          };

          const responseStartTimeoutMs =
            opts.responseStartTimeoutMs ?? DEFAULT_WS_RESPONSE_START_TIMEOUT_MS;
          if (responseStartTimeoutMs > 0) {
            this.currentSession.responseStartTimer = setTimeout(
              () => this.handleResponseStartTimeout(responseStartTimeoutMs),
              responseStartTimeoutMs,
            );
            this.currentSession.responseStartTimer.unref?.();
          }

          if (opts.signal) {
            const listener = () => this.handleAbort();
            opts.signal.addEventListener("abort", listener, { once: true });
            this.currentSession.abortListener = listener;
          }
        },
        cancel: () => {
          // Caller stopped reading the stream mid-flight. Server may still
          // push tail frames; evict to prevent corrupting the next reuser.
          this.markDead("stream cancelled by caller");
        },
      });

      try {
        this.ws.send(JSON.stringify(opts.request));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.busy = false;
        this.markDead(`send failed: ${msg}`);
        wrappedReject(err instanceof Error ? err : new Error(msg));
      }
    });
  }

  /** Mark this WS for graceful close. If busy, defer until the in-flight
   *  request completes; otherwise close immediately. */
  closeGracefully(): void {
    this.pendingClose = true;
    if (!this.busy) {
      this.markDead("closeGracefully");
    }
  }

  /** Force-close + mark dead + notify pool. Used on terminal failures. */
  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    try { this.ws.close(1000, reason.slice(0, 120)); } catch { /* already closing */ }
    if (this.currentSession) {
      this.clearResponseStartTimer(this.currentSession);
      if (!this.currentSession.streamClosed) {
        try { this.currentSession.controller.close(); } catch { /* already closed */ }
        this.currentSession.streamClosed = true;
      }
    }
    this.detachAbortListener();
    this.busy = false;
    this.currentSession = null;
    try { this.hooks.onDead(); } catch { /* hook errors must not propagate */ }
  }

  private handleResponseStartTimeout(timeoutMs: number): void {
    const sess = this.currentSession;
    if (!sess || sess.earlyDecisionMade) return;
    sess.earlyDecisionMade = true;
    sess.reject(new Error(`WebSocket response start timeout after ${timeoutMs}ms`));
    this.markDead("response start timeout");
  }

  private clearResponseStartTimer(sess: InFlightSession): void {
    if (!sess.responseStartTimer) return;
    clearTimeout(sess.responseStartTimer);
    sess.responseStartTimer = undefined;
  }

  private detachAbortListener(): void {
    const sess = this.currentSession;
    if (sess?.signal && sess.abortListener) {
      sess.signal.removeEventListener("abort", sess.abortListener);
      sess.abortListener = null;
    }
  }

  private buildResponse(stream: ReadableStream<Uint8Array>): Response {
    const responseHeaders = new Headers({ "content-type": "text/event-stream" });
    for (const [key, value] of Object.entries(this.upgradeHeaders)) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v != null) responseHeaders.set(key, v);
    }
    return new Response(stream, { status: 200, headers: responseHeaders });
  }

  private enqueueSessionChunk(sess: InFlightSession, chunk: Uint8Array): void {
    if (sess.streamClosed) return;
    sess.controller.enqueue(chunk);
  }

  private resolveSessionResponse(sess: InFlightSession): void {
    if (sess.earlyDecisionMade) return;
    sess.earlyDecisionMade = true;
    this.clearResponseStartTimer(sess);
    sess.resolveResponse();
    for (const chunk of sess.earlyMetadataChunks.splice(0)) {
      this.enqueueSessionChunk(sess, chunk);
    }
  }

  private handleMessage(data: Buffer | string): void {
    const sess = this.currentSession;
    if (!sess || sess.streamClosed) return;

    const raw = typeof data === "string" ? data : data.toString("utf-8");
    let msg: Record<string, unknown> | null = null;
    let type = "unknown";
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
      type = typeof msg.type === "string" ? msg.type : "unknown";
    } catch {
      /* fall through to raw passthrough */
    }

    // Internal rate-limit frames bypass the stream and don't flip the
    // early-decision flag; they're observed via the per-session callback.
    if (msg && type === "codex.rate_limits") {
      const rl = parseRateLimitsEvent(msg);
      if (rl) sess.onRateLimits?.(rl);
      return;
    }

    if (!sess.earlyDecisionMade) {
      if (msg) {
        const classified = classifyWsErrorEvent(msg);
        if (classified) {
          sess.reject(new CodexApiError(classified.status, JSON.stringify(msg)));
          // Server connection-cap is a per-connection failure: evict so the
          // next caller opens a fresh WS instead of hitting the same wall.
          if (classified.code === "websocket_connection_limit_reached") {
            this.markDead("server connection limit");
          } else {
            this.releaseAfterEarlyError();
          }
          return;
        }
        if (isEarlyMetadataWsEvent(type)) {
          sess.earlyMetadataChunks.push(this.encoder.encode(`event: ${type}\ndata: ${raw}\n\n`));
          return;
        }
      }
      this.resolveSessionResponse(sess);
      // Fall through to enqueue this first frame.
    }

    if (msg) {
      const sse = `event: ${type}\ndata: ${raw}\n\n`;
      this.enqueueSessionChunk(sess, this.encoder.encode(sse));

      if (isTerminalWsEvent(type)) {
        sess.sawTerminalEvent = true;
        const responseId = completedResponseId(msg, type);
        if (responseId) this.hooks.onResponseCompleted?.(responseId);
        queueMicrotask(() => this.releaseAfterTerminalFrame());
      }
    } else {
      this.enqueueSessionChunk(sess, this.encoder.encode(`data: ${raw}\n\n`));
    }
  }

  private handleAbort(): void {
    const sess = this.currentSession;
    if (!sess) return;
    if (!sess.earlyDecisionMade) {
      sess.earlyDecisionMade = true;
      sess.reject(new Error("Aborted during WebSocket request"));
    } else if (!sess.streamClosed) {
      try { sess.controller.error(new Error("Aborted during WebSocket stream")); } catch { /* already closed */ }
      sess.streamClosed = true;
    }
    // Caller-initiated abort poisons the connection (server may still push
    // tail frames) — evict.
    this.markDead("aborted");
  }

  private handleTransportError(err: Error): void {
    const sess = this.currentSession;
    if (!sess) {
      // Idle connection died while waiting in the pool — evict so next
      // acquire creates a fresh one. No in-flight request to fail.
      this.markDead(`transport error (idle): ${err.message}`);
      return;
    }
    if (!sess.earlyDecisionMade) {
      sess.earlyDecisionMade = true;
      sess.reject(err);
    } else if (!sess.streamClosed) {
      try { sess.controller.error(err); } catch { /* already closed */ }
      sess.streamClosed = true;
    }
    this.markDead(`transport error: ${err.message}`);
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason && reason.length ? reason.toString("utf-8") : "";
    const sess = this.currentSession;
    if (sess && !sess.earlyDecisionMade) {
      sess.earlyDecisionMade = true;
      sess.reject(new Error(
        `WebSocket closed before terminal event: code=${code}` +
          (reasonStr ? ` reason=${reasonStr}` : ""),
      ));
    } else if (sess && !sess.streamClosed) {
      if (sess.sawTerminalEvent) {
        try { sess.controller.close(); } catch { /* already closed */ }
      } else {
        try {
          sess.controller.error(new Error(
            `WebSocket closed before terminal event: code=${code}` +
              (reasonStr ? ` reason=${reasonStr}` : ""),
          ));
        } catch { /* already closed */ }
      }
      sess.streamClosed = true;
    }
    this.markDead(`closed code=${code}${reasonStr ? ` reason=${reasonStr}` : ""}`);
  }

  /** Stream completed normally (response.completed/failed/error). Close the
   *  outbound stream but keep the WS open for the next caller. */
  private releaseAfterTerminalFrame(): void {
    const sess = this.currentSession;
    if (sess && !sess.streamClosed) {
      try { sess.controller.close(); } catch { /* already closed */ }
      sess.streamClosed = true;
    }
    this.detachAbortListener();
    this.currentSession = null;
    this.busy = false;
    if (this.pendingClose) this.markDead("pending close after terminal frame");
  }

  /** Early classified error already rejected the send-level promise. The
   *  WS itself is fine to reuse for the next conversation, but for safety we
   *  treat early errors as account-level and keep the WS open only if the
   *  error wasn't connection-fatal. */
  private releaseAfterEarlyError(): void {
    if (this.currentSession) this.clearResponseStartTimer(this.currentSession);
    this.detachAbortListener();
    this.currentSession = null;
    this.busy = false;
    if (this.pendingClose) this.markDead("pending close after early error");
  }
}

// ── WsConnectionPool ───────────────────────────────────────────────

export interface WsPoolConfig {
  enabled: boolean;
  maxAgeMs: number;
  maxPerAccount: number;
}

export const DEFAULT_WS_POOL_CONFIG: WsPoolConfig = {
  enabled: true,
  maxAgeMs: 3_300_000, // 55 minutes (under server's 60-min hard cap). Mirrored in `IMPLICIT_RESUME_MAX_AGE_MS` (proxy-session-helpers.ts) — keep them in sync.
  maxPerAccount: 8,
};

export interface AcquireResult {
  ws: PersistentWs;
  reused: boolean;
}

export type AcquireBypassReason =
  | "busy"
  | "cap"
  | "dead"
  | "expired"
  | "disabled"
  | "no_key"
  | "missing_owner"
  | "account_mismatch";

export interface AcquireBypass {
  bypass: AcquireBypassReason;
}

export type ResponseOwnerBypassReason = Exclude<AcquireBypassReason, "cap">;

export interface ResponseOwnerBypass {
  bypass: ResponseOwnerBypassReason;
}

export interface PersistentWsFactory {
  /** Called when the pool needs a new WS. The factory must construct a
   *  PersistentWs whose `hooks.onDead` callback maps back to the pool. */
  (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }): Promise<PersistentWs>;
}

export class WsConnectionPool {
  private readonly map = new Map<string, PersistentWs>();
  private readonly byEntry = new Map<string, Set<string>>();
  /** In-progress factories count against the per-account cap. */
  private readonly pendingCreatesByEntry = new Map<string, number>();
  /** Response IDs are valid only on the physical WS that completed them. */
  private readonly ownerByResponse = new Map<string, string>();
  /** The upstream keeps only the most recent response per physical WS. */
  private readonly responseByPoolKey = new Map<string, string>();
  private readonly config: WsPoolConfig;
  private gcInterval: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(config: Partial<WsPoolConfig> = {}, opts: { startGc?: boolean; gcIntervalMs?: number } = {}) {
    this.config = { ...DEFAULT_WS_POOL_CONFIG, ...config };
    if (opts.startGc !== false && this.config.enabled) {
      this.gcInterval = setInterval(() => this.gcSweep(), opts.gcIntervalMs ?? 60_000);
      this.gcInterval.unref?.();
    }
  }

  /** Try to get a usable PersistentWs for `(entryId, poolKey)`.
   *
   *  - Empty `poolKey` (no conversationId derivable) → bypass.
   *  - Pool disabled → bypass.
   *  - Hit + tryAcquire → reused=true.
   *  - Hit + busy → bypass(busy).
   *  - Hit + dead/closed → evict + treat as miss.
   *  - Miss + at cap for entryId → bypass(cap).
   *  - Miss + free slot → factory(), insert, reused=false.
   */
  async acquire(
    entryId: string,
    poolKey: string,
    factory: PersistentWsFactory,
  ): Promise<AcquireResult | AcquireBypass> {
    if (!this.config.enabled || this.shuttingDown) {
      return { bypass: "disabled" };
    }
    if (!entryId || !poolKey) {
      return { bypass: "no_key" };
    }

    let existing = this.map.get(poolKey);
    if (existing && (!existing.isAlive() || existing.isExpired(this.config.maxAgeMs))) {
      existing.closeGracefully();
      this.removeEntry(existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.tryAcquire()) {
        return { ws: existing, reused: true };
      }
      return { bypass: "busy" };
    }

    // Miss: reserve capacity before awaiting the factory so concurrent
    // different-key acquires cannot all pass the same per-account cap check.
    const keys = this.byEntry.get(entryId);
    const pendingCreates = this.pendingCreatesByEntry.get(entryId) ?? 0;
    if ((keys?.size ?? 0) + pendingCreates >= this.config.maxPerAccount) {
      return { bypass: "cap" };
    }
    this.pendingCreatesByEntry.set(entryId, pendingCreates + 1);

    let freshRef: PersistentWs | undefined;
    let fresh: PersistentWs;
    try {
      fresh = await factory({
        entryId,
        poolKey,
        hooks: {
          onDead: () => {
            // A same-key connection may have won the factory race. Never let a
            // discarded fresh connection remove that winner from the pool.
            if (freshRef && this.map.get(poolKey) === freshRef) {
              this.removeEntryByKey(poolKey);
            }
          },
          onResponseCompleted: (responseId) => {
            if (freshRef && this.map.get(poolKey) === freshRef) {
              this.registerResponseOwner(poolKey, responseId);
            }
          },
        },
      });
      freshRef = fresh;
    } finally {
      this.releasePendingCreate(entryId);
    }

    // Race: another acquire for the same key may have completed during
    // factory() await. If so, prefer the one already in the map.
    const racer = this.map.get(poolKey);
    if (racer) {
      // Discard the freshly-created ws — close it cleanly.
      fresh.closeGracefully();
      if (racer.isAlive() && racer.tryAcquire()) {
        return { ws: racer, reused: true };
      }
      // Racer is busy too — bypass and let caller open a one-shot.
      return { bypass: "busy" };
    }

    if (!fresh.tryAcquire()) {
      // Should be impossible (we just created it), but be defensive: don't
      // leave a permanently-busy entry in the map.
      fresh.closeGracefully();
      return { bypass: "dead" };
    }

    this.map.set(poolKey, fresh);
    let entryKeys = this.byEntry.get(entryId);
    if (!entryKeys) {
      entryKeys = new Set();
      this.byEntry.set(entryId, entryKeys);
    }
    entryKeys.add(poolKey);
    return { ws: fresh, reused: false };
  }

  /** Atomically acquire the physical WS that owns `previousResponseId`.
   *  This method never creates a connection: a response ID must not cross a
   *  physical WebSocket boundary when store=false. */
  acquireForResponse(entryId: string, previousResponseId: string): AcquireResult | ResponseOwnerBypass {
    if (!this.config.enabled || this.shuttingDown) return { bypass: "disabled" };
    if (!entryId || !previousResponseId) return { bypass: "no_key" };

    const poolKey = this.ownerByResponse.get(previousResponseId);
    if (!poolKey) return { bypass: "missing_owner" };
    const owner = this.map.get(poolKey);
    if (!owner) {
      this.forgetResponseOwner(previousResponseId);
      return { bypass: "missing_owner" };
    }
    if (owner.entryId !== entryId) return { bypass: "account_mismatch" };
    if (!owner.isAlive()) {
      this.removeEntry(owner);
      return { bypass: "dead" };
    }
    if (owner.isExpired(this.config.maxAgeMs)) {
      owner.closeGracefully();
      this.removeEntry(owner);
      return { bypass: "expired" };
    }
    if (!owner.tryAcquire()) return { bypass: "busy" };
    return { ws: owner, reused: true };
  }

  /** Test/diagnostic helper: return the owning physical WS id. */
  ownerWsId(previousResponseId: string): string | null {
    const poolKey = this.ownerByResponse.get(previousResponseId);
    return poolKey ? this.map.get(poolKey)?.id ?? null : null;
  }

  /** Remove a stale response owner without evicting an otherwise healthy WS. */
  forgetResponseOwner(previousResponseId: string): void {
    const poolKey = this.ownerByResponse.get(previousResponseId);
    if (!poolKey) return;
    this.ownerByResponse.delete(previousResponseId);
    if (this.responseByPoolKey.get(poolKey) === previousResponseId) {
      this.responseByPoolKey.delete(poolKey);
    }
  }

  /** Evict every WS for the given entryId. Used when the account is
   *  rate-limited / banned / disabled / refreshed (token rotated). */
  evictByEntryId(entryId: string): void {
    const keys = this.byEntry.get(entryId);
    if (!keys) return;
    // Snapshot keys before iteration — closeGracefully → onDead → removeEntryByKey
    // would mutate the set we're iterating.
    for (const key of [...keys]) {
      const ws = this.map.get(key);
      if (ws) ws.closeGracefully();
    }
    // closeGracefully on a busy ws sets pendingClose; the actual map removal
    // happens when the in-flight request completes. Force-clear the byEntry
    // index now so subsequent acquires don't count against the cap.
    this.byEntry.delete(entryId);
  }

  /** Returns the number of pooled connections for `entryId`. Test helper. */
  countByEntryId(entryId: string): number {
    return this.byEntry.get(entryId)?.size ?? 0;
  }

  /** Returns total pool size. Test helper. */
  size(): number {
    return this.map.size;
  }

  /** Gracefully close all pooled connections. Called from process exit. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }
    for (const ws of [...this.map.values()]) {
      ws.closeGracefully();
    }
    // Leave map empty after all entries are forcibly closed; subsequent
    // acquires would fail the disabled check anyway.
    this.map.clear();
    this.byEntry.clear();
    this.pendingCreatesByEntry.clear();
    this.ownerByResponse.clear();
    this.responseByPoolKey.clear();
  }

  /** Periodic sweep: drop dead/expired idle entries. Skips busy ones. */
  gcSweep(): void {
    for (const [, ws] of this.map) {
      if (ws.isBusy()) continue;
      if (!ws.isAlive() || ws.isExpired(this.config.maxAgeMs)) {
        ws.closeGracefully();
      }
    }
  }

  private releasePendingCreate(entryId: string): void {
    const pendingCreates = this.pendingCreatesByEntry.get(entryId);
    if (!pendingCreates || pendingCreates <= 1) {
      this.pendingCreatesByEntry.delete(entryId);
      return;
    }
    this.pendingCreatesByEntry.set(entryId, pendingCreates - 1);
  }

  private registerResponseOwner(poolKey: string, responseId: string): void {
    if (!this.map.has(poolKey)) return;
    const previous = this.responseByPoolKey.get(poolKey);
    if (previous && previous !== responseId) this.ownerByResponse.delete(previous);
    const previousPoolKey = this.ownerByResponse.get(responseId);
    if (previousPoolKey && previousPoolKey !== poolKey) {
      this.responseByPoolKey.delete(previousPoolKey);
    }
    this.responseByPoolKey.set(poolKey, responseId);
    this.ownerByResponse.set(responseId, poolKey);
  }

  private removeEntry(ws: PersistentWs): void {
    this.removeEntryByKey(ws.poolKey);
  }

  private removeEntryByKey(poolKey: string): void {
    const ws = this.map.get(poolKey);
    if (!ws) return;
    this.map.delete(poolKey);
    const ownedResponse = this.responseByPoolKey.get(poolKey);
    if (ownedResponse) {
      this.responseByPoolKey.delete(poolKey);
      this.ownerByResponse.delete(ownedResponse);
    }
    const entryKeys = this.byEntry.get(ws.entryId);
    if (entryKeys) {
      entryKeys.delete(poolKey);
      if (entryKeys.size === 0) this.byEntry.delete(ws.entryId);
    }
  }
}

// ── Singleton (used by app code; tests construct their own) ────────

let _singleton: WsConnectionPool | null = null;

export function getWsPool(): WsConnectionPool {
  if (!_singleton) _singleton = new WsConnectionPool();
  return _singleton;
}

export function setWsPoolConfig(config: Partial<WsPoolConfig>): WsConnectionPool {
  if (_singleton) {
    // Replace existing singleton with new config; let GC clean old one.
    void _singleton.shutdown();
  }
  _singleton = new WsConnectionPool(config);
  return _singleton;
}

/** Test-only: reset the singleton so each test gets a clean pool. */
export function _resetWsPoolForTests(): void {
  if (_singleton) void _singleton.shutdown();
  _singleton = null;
}
