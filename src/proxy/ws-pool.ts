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
  /** Resolves the outer send() Promise with the SSE Response.
   *  Closes over the freshly-built ReadableStream so callers don't need to
   *  pass it back in. */
  resolveResponse: () => void;
  reject: (err: Error) => void;
  abortListener: (() => void) | null;
  signal: AbortSignal | undefined;
  streamClosed: boolean;
}

/** Subset of the `ws` module's WebSocket interface that PersistentWs needs.
 *  Declared here to avoid pulling in the `ws` typedefs at module load (it's
 *  lazy-loaded). Real ws.WebSocket is structurally compatible. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "upgrade", listener: (response: { headers: Record<string, string | string[]> }) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
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

// ── PersistentWs ───────────────────────────────────────────────────

export interface PersistentWsHooks {
  /** Called when this WS becomes unusable (close, error, eviction).
   *  The pool uses this to remove the entry from its map. */
  onDead(): void;
}

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

  constructor(opts: {
    ws: WsLike;
    entryId: string;
    poolKey: string;
    hooks: PersistentWsHooks;
    now?: () => number;
  }) {
    this.id = randomUUID().slice(0, 8);
    this.ws = opts.ws;
    this.entryId = opts.entryId;
    this.poolKey = opts.poolKey;
    this.hooks = opts.hooks;
    this.now = opts.now ?? Date.now;
    this.createdAt = this.now();

    this.ws.on("upgrade", (response) => {
      this.upgradeHeaders = response.headers;
    });

    this.ws.on("message", (data) => this.handleMessage(data));

    this.ws.on("error", (err) => this.handleTransportError(err));

    this.ws.on("close", (code, reason) => this.handleClose(code, reason));
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
            resolveResponse: () => resolve(this.buildResponse(stream)),
            reject: wrappedReject,
            abortListener: null,
            signal: opts.signal,
            streamClosed: false,
          };

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
    try { this.ws.close(1000, reason.slice(0, 120)); } catch { /* already closing */ }
    if (this.currentSession && !this.currentSession.streamClosed) {
      try { this.currentSession.controller.close(); } catch { /* already closed */ }
      this.currentSession.streamClosed = true;
    }
    this.detachAbortListener();
    this.busy = false;
    this.currentSession = null;
    try { this.hooks.onDead(); } catch { /* hook errors must not propagate */ }
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
    if (msg && type === "codex.rate_limits" && sess.onRateLimits) {
      const rl = parseRateLimitsEvent(msg);
      if (rl) sess.onRateLimits(rl);
      return;
    }

    if (!sess.earlyDecisionMade) {
      sess.earlyDecisionMade = true;
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
      }
      sess.resolveResponse();
      // Fall through to enqueue this first frame.
    }

    if (msg) {
      const sse = `event: ${type}\ndata: ${raw}\n\n`;
      sess.controller.enqueue(this.encoder.encode(sse));

      if (type === "response.completed" || type === "response.failed" || type === "error") {
        queueMicrotask(() => this.releaseAfterTerminalFrame());
      }
    } else {
      sess.controller.enqueue(this.encoder.encode(`data: ${raw}\n\n`));
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
        `WebSocket closed before any data: code=${code}` +
          (reasonStr ? ` reason=${reasonStr}` : ""),
      ));
    } else if (sess && !sess.streamClosed) {
      try { sess.controller.close(); } catch { /* already closed */ }
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
  maxAgeMs: 3_300_000, // 55 minutes (under server's 60-min hard cap)
  maxPerAccount: 8,
};

export interface AcquireResult {
  ws: PersistentWs;
  reused: boolean;
}

export type AcquireBypassReason = "busy" | "cap" | "dead" | "disabled" | "no_key";

export interface AcquireBypass {
  bypass: AcquireBypassReason;
}

export interface PersistentWsFactory {
  /** Called when the pool needs a new WS. The factory must construct a
   *  PersistentWs whose `hooks.onDead` callback maps back to the pool. */
  (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }): Promise<PersistentWs>;
}

export class WsConnectionPool {
  private readonly map = new Map<string, PersistentWs>();
  private readonly byEntry = new Map<string, Set<string>>();
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
    if (existing && !existing.isAlive()) {
      this.removeEntry(existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.tryAcquire()) {
        return { ws: existing, reused: true };
      }
      return { bypass: "busy" };
    }

    // Miss: enforce per-account cap before creating.
    const keys = this.byEntry.get(entryId);
    if (keys && keys.size >= this.config.maxPerAccount) {
      return { bypass: "cap" };
    }

    const fresh = await factory({
      entryId,
      poolKey,
      hooks: {
        onDead: () => {
          // Pool-side cleanup. PersistentWs already marked itself dead.
          this.removeEntryByKey(poolKey);
        },
      },
    });

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

  private removeEntry(ws: PersistentWs): void {
    this.removeEntryByKey(ws.poolKey);
  }

  private removeEntryByKey(poolKey: string): void {
    const ws = this.map.get(poolKey);
    if (!ws) return;
    this.map.delete(poolKey);
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
