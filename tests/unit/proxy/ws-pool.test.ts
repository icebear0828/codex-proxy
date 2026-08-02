import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import {
  PersistentWs,
  WsConnectionPool,
  WsReusedConnectionError,
  setWsPoolConfig,
  getWsPool,
  _resetWsPoolForTests,
  type PersistentWsHooks,
  type WsLike,
} from "@src/proxy/ws-pool.js";
import { CodexApiError } from "@src/proxy/codex-types.js";

class MockWs extends EventEmitter implements WsLike {
  public readyState = 1; // OPEN
  public sent: string[] = [];
  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public pingCount = 0;

  send(data: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  ping(): void {
    if (this.closed) throw new Error("ping after close");
    this.pingCount += 1;
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    queueMicrotask(() => this.emit("close", code ?? 1006, Buffer.from(reason ?? "")));
  }

  /** Simulate the server pushing a JSON frame over the wire. */
  pushMessage(payload: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(payload));
  }

  /** Simulate a transport-level error (TCP RST, etc.). */
  pushError(err: Error): void {
    this.emit("error", err);
  }

  /** Simulate the server closing the socket abruptly. */
  pushClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.closed = true;
    this.emit("close", code, Buffer.from(reason));
  }
}

function newPersistentWs(opts: { hooks?: Partial<PersistentWsHooks>; entryId?: string; poolKey?: string; pingIntervalMs?: number; livenessTimeoutMs?: number } = {}) {
  const ws = new MockWs();
  const onDead = vi.fn();
  const persistent = new PersistentWs({
    ws,
    entryId: opts.entryId ?? "entry-A",
    poolKey: opts.poolKey ?? "entry-A:conv-1",
    hooks: { onDead, ...opts.hooks },
    pingIntervalMs: opts.pingIntervalMs,
    livenessTimeoutMs: opts.livenessTimeoutMs,
  });
  return { ws, persistent, onDead };
}

async function nextTick() {
  await new Promise<void>((r) => queueMicrotask(r));
}

describe("PersistentWs", () => {
  it("tryAcquire succeeds once on a fresh OPEN ws", () => {
    const { persistent } = newPersistentWs();
    expect(persistent.tryAcquire()).toBe(true);
    expect(persistent.tryAcquire()).toBe(false); // already busy
  });

  it("tryAcquire fails when readyState is not OPEN", () => {
    const { ws, persistent } = newPersistentWs();
    ws.readyState = 0; // CONNECTING
    expect(persistent.tryAcquire()).toBe(false);
  });

  it("send rejects with WsReusedConnectionError on pre-response close (reused=true)", async () => {
    const { ws, persistent } = newPersistentWs();
    expect(persistent.tryAcquire()).toBe(true);
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: true,
    });
    await nextTick();
    ws.pushClose(1006, "tcp rst");
    await expect(promise).rejects.toBeInstanceOf(WsReusedConnectionError);
  });

  it("send rejects with plain Error on pre-response close (reused=false)", async () => {
    const { ws, persistent } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushClose(1006, "tcp rst");
    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.not.toBeInstanceOf(WsReusedConnectionError);
  });

  it("send resolves Response on first non-metadata frame and flushes early metadata", async () => {
    const { ws, persistent } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created", id: "r1" });
    ws.pushMessage({ type: "response.output_text.delta", delta: "hi" });
    const resp = await promise;
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    ws.pushMessage({ type: "response.completed" });
    const text = await resp.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
  });

  it("send rejects before resolving when the WS closes after only metadata", async () => {
    const { ws, persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: true,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created", response: { id: "resp_mid" } });
    ws.pushClose(1000, "");

    await expect(promise).rejects.toBeInstanceOf(WsReusedConnectionError);
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalled();
  });

  describe("response start timeout", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("rejects and evicts when upstream sends only provisional metadata", async () => {
      const { ws, persistent, onDead } = newPersistentWs({ pingIntervalMs: 0 });
      persistent.tryAcquire();
      const promise = persistent.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: false,
        responseStartTimeoutMs: 1_000,
      });
      promise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      ws.pushMessage({ type: "response.created", response: { id: "resp_waiting" } });
      ws.pushMessage({ type: "codex.response.metadata", headers: { "x-test": "1" } });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).rejects.toThrow("WebSocket response start timeout after 1000ms");
      expect(persistent.isAlive()).toBe(false);
      expect(ws.closeReason).toBe("response start timeout");
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    it("classifies a continuation timeout as a reused-connection failure", async () => {
      const { ws, persistent } = newPersistentWs({ pingIntervalMs: 0 });
      persistent.tryAcquire();
      const promise = persistent.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: true,
        responseStartTimeoutMs: 1_000,
      });
      promise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      ws.pushMessage({ type: "response.created", response: { id: "resp_waiting" } });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).rejects.toMatchObject({
        name: "WsReusedConnectionError",
        message: "WebSocket response start timeout after 1000ms",
      });
      expect(persistent.isAlive()).toBe(false);
    });

    it("clears the deadline after the first client-visible event", async () => {
      const { ws, persistent } = newPersistentWs({ pingIntervalMs: 0 });
      persistent.tryAcquire();
      const promise = persistent.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: false,
        responseStartTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      ws.pushMessage({ type: "response.created", response: { id: "resp_started" } });
      ws.pushMessage({ type: "response.output_text.delta", delta: "started" });
      const response = await promise;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(persistent.isAlive()).toBe(true);
      ws.pushMessage({ type: "response.completed", response: { id: "resp_started" } });
      await expect(response.text()).resolves.toContain("response.completed");
    });
  });

  it("errors the response stream when the WS closes after a visible frame without terminal event", async () => {
    const { ws, persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created", response: { id: "resp_mid" } });
    ws.pushMessage({ type: "response.output_text.delta", delta: "partial" });
    const resp = await promise;
    ws.pushClose(1006, "tcp rst");

    await expect(resp.text()).rejects.toThrow("WebSocket closed before terminal event");
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalled();
  });

  it("after response.completed the WS becomes available for the next send", async () => {
    const { ws, persistent } = newPersistentWs();
    persistent.tryAcquire();
    const p1 = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created" });
    ws.pushMessage({ type: "response.completed" });
    const r1 = await p1;
    await r1.text();
    await nextTick();
    expect(persistent.isBusy()).toBe(false);
    expect(persistent.isAlive()).toBe(true);
    expect(persistent.tryAcquire()).toBe(true);
  });

  it("rate_limits frame routes only to the per-session callback and does not stream", async () => {
    const { ws, persistent } = newPersistentWs();
    persistent.tryAcquire();
    const onRateLimits = vi.fn();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 50, window_minutes: 60 } },
    });
    expect(onRateLimits).toHaveBeenCalledTimes(1);
    ws.pushMessage({ type: "response.created" });
    ws.pushMessage({ type: "response.completed" });
    const resp = await promise;
    const text = await resp.text();
    expect(text).not.toContain("codex.rate_limits");
  });

  it("classified early error rejects with CodexApiError without resolving stream", async () => {
    const { ws, persistent } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: true, // even reused, classified errors stay as CodexApiError
    });
    await nextTick();
    ws.pushMessage({ type: "error", error: { code: "usage_limit_reached", message: "limit" } });
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CodexApiError);
    expect((err as CodexApiError).status).toBe(429);
  });

  it("websocket_connection_limit_reached early error evicts the WS", async () => {
    const { ws, persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({
      type: "error",
      error: { code: "websocket_connection_limit_reached", message: "60 min limit" },
    });
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CodexApiError);
    expect((err as CodexApiError).status).toBe(503);
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalled();
  });

  it("AbortSignal abort during in-flight rejects + evicts (cannot poison the next reuser)", async () => {
    const { persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const ac = new AbortController();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: ac.signal,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalled();
  });

  it("transport error before any message rejects the in-flight send and evicts", async () => {
    const { ws, persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: true,
    });
    await nextTick();
    ws.pushError(new Error("ECONNRESET"));
    await expect(promise).rejects.toBeInstanceOf(WsReusedConnectionError);
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalled();
  });

  it("idle close on a connection without an in-flight session evicts cleanly", () => {
    const { ws, persistent, onDead } = newPersistentWs();
    expect(persistent.isAlive()).toBe(true);
    ws.pushClose(1006, "idle drop");
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("closeGracefully on busy WS defers eviction until terminal frame", async () => {
    const { ws, persistent, onDead } = newPersistentWs();
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created" });
    ws.pushMessage({ type: "response.output_text.delta", delta: "partial" });
    const resp = await promise;
    persistent.closeGracefully();
    expect(onDead).not.toHaveBeenCalled(); // still busy
    ws.pushMessage({ type: "response.completed" });
    await resp.text();
    await nextTick();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(persistent.isAlive()).toBe(false);
  });

  it("closeGracefully on idle WS evicts immediately", () => {
    const { persistent, onDead } = newPersistentWs();
    persistent.closeGracefully();
    expect(persistent.isAlive()).toBe(false);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("isExpired returns true once max age has elapsed", () => {
    let now = 1_000_000;
    const ws = new MockWs();
    const persistent = new PersistentWs({
      ws,
      entryId: "e",
      poolKey: "k",
      hooks: { onDead: () => {} },
      now: () => now,
    });
    expect(persistent.isExpired(60_000)).toBe(false);
    now += 60_001;
    expect(persistent.isExpired(60_000)).toBe(true);
  });

  it("upgrade headers are cached and surfaced on Response", async () => {
    const { ws, persistent } = newPersistentWs();
    ws.emit("upgrade", { headers: { "x-codex-primary-used-percent": "42" } });
    persistent.tryAcquire();
    const promise = persistent.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    await nextTick();
    ws.pushMessage({ type: "response.created" });
    ws.pushMessage({ type: "response.completed" });
    const resp = await promise;
    expect(resp.headers.get("x-codex-primary-used-percent")).toBe("42");
  });

  describe("keepalive ping", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("emits ping frames at the configured interval to keep middlebox NAT alive", () => {
      const { ws } = newPersistentWs({ pingIntervalMs: 1_000 });
      expect(ws.pingCount).toBe(0);
      vi.advanceTimersByTime(2_500);
      expect(ws.pingCount).toBe(2);
    });

    it("stops pinging once the WS is dead", () => {
      const { ws } = newPersistentWs({ pingIntervalMs: 1_000 });
      vi.advanceTimersByTime(1_500);
      expect(ws.pingCount).toBe(1);
      ws.pushClose(1006, "tcp rst");
      vi.advanceTimersByTime(5_000);
      expect(ws.pingCount).toBe(1);
    });

    it("skips ping when the underlying ws is no longer OPEN", () => {
      const { ws } = newPersistentWs({ pingIntervalMs: 1_000 });
      ws.readyState = 2; // CLOSING — close event hasn't fired yet
      vi.advanceTimersByTime(3_500);
      expect(ws.pingCount).toBe(0);
    });

    it("pingIntervalMs=0 disables the keepalive timer entirely", () => {
      const { ws } = newPersistentWs({ pingIntervalMs: 0 });
      vi.advanceTimersByTime(60_000);
      expect(ws.pingCount).toBe(0);
    });

    it("swallows ping errors AND keeps firing on subsequent ticks", () => {
      const { ws } = newPersistentWs({ pingIntervalMs: 1_000 });
      const original = ws.ping.bind(ws);
      let throwOnce = true;
      ws.ping = () => {
        if (throwOnce) { throwOnce = false; throw new Error("transient"); }
        original();
      };
      expect(() => vi.advanceTimersByTime(2_500)).not.toThrow();
      // Tick 1 threw and was swallowed; tick 2 must have fired and incremented.
      // Asserts the timer loop survived the throw — a bare not.toThrow() would
      // miss a regression that crashes the interval after one bad ping.
      expect(ws.pingCount).toBe(1);
    });

    it("continues pinging while a request is in-flight", async () => {
      const { ws, persistent } = newPersistentWs({
        pingIntervalMs: 1_000,
        livenessTimeoutMs: 0,
      });
      persistent.tryAcquire();
      void persistent.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: false,
      });
      await vi.advanceTimersByTimeAsync(0); // let send() start
      vi.advanceTimersByTime(3_500);
      expect(ws.pingCount).toBe(3);
    });
  });

  describe("liveness check (silent connection death)", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("marks ws dead once upstream stays silent past livenessTimeoutMs", () => {
      const { ws, persistent, onDead } = newPersistentWs({
        pingIntervalMs: 1_000,
        livenessTimeoutMs: 2_500,
      });
      // No pong, no message: lastActivity stays at construction time.
      vi.advanceTimersByTime(3_000);
      expect(persistent.isAlive()).toBe(false);
      expect(onDead).toHaveBeenCalledTimes(1);
      expect(ws.closed).toBe(true);
    });

    it("pong frame from upstream resets the liveness clock", () => {
      const { ws, persistent } = newPersistentWs({
        pingIntervalMs: 1_000,
        livenessTimeoutMs: 2_500,
      });
      vi.advanceTimersByTime(2_000);
      ws.emit("pong"); // pong arrives just before the deadline
      vi.advanceTimersByTime(2_000); // would have crossed 4s without reset
      expect(persistent.isAlive()).toBe(true);
    });

    it("data message from upstream also counts as proof of life", async () => {
      const { ws, persistent } = newPersistentWs({
        pingIntervalMs: 1_000,
        livenessTimeoutMs: 2_500,
      });
      persistent.tryAcquire();
      void persistent.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(2_000);
      ws.pushMessage({ type: "response.created" });
      vi.advanceTimersByTime(2_000);
      expect(persistent.isAlive()).toBe(true);
    });

    it("disabled when livenessTimeoutMs=0 (escape hatch matches pingIntervalMs=0)", () => {
      const { persistent } = newPersistentWs({
        pingIntervalMs: 1_000,
        livenessTimeoutMs: 0,
      });
      vi.advanceTimersByTime(60_000);
      expect(persistent.isAlive()).toBe(true);
    });

    it("livenessTimeoutMs defaults to a multiple of pingIntervalMs (no surprise dead WS in healthy state)", () => {
      // Default is 2.5x ping interval. With 1s ping and one pong arriving each
      // cycle, liveness must hold across many cycles.
      const { ws, persistent } = newPersistentWs({ pingIntervalMs: 1_000 });
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1_000);
        ws.emit("pong");
      }
      expect(persistent.isAlive()).toBe(true);
    });
  });
});

describe("WsConnectionPool", () => {
  let pool: WsConnectionPool;

  beforeEach(() => {
    pool = new WsConnectionPool({}, { startGc: false });
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  function makeFactory() {
    const created: PersistentWs[] = [];
    const factory = vi.fn(async (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) => {
      const ws = new MockWs();
      const persistent = new PersistentWs({
        ws,
        entryId: deps.entryId,
        poolKey: deps.poolKey,
        hooks: deps.hooks,
      });
      created.push(persistent);
      return persistent;
    });
    return { factory, created };
  }

  it("acquire miss creates and caches a new PersistentWs (reused=false)", async () => {
    const { factory } = makeFactory();
    const r = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(r).toMatchObject({ reused: false });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(1);
    expect(pool.countByEntryId("entry-A")).toBe(1);
  });

  it("acquire hit returns same instance after release (reused=true)", async () => {
    const { factory } = makeFactory();
    const first = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    if (!("ws" in first)) throw new Error("expected acquire success");
    // Simulate release by completing a request: trigger terminal frame.
    const wsInst = first.ws;
    wsInst["busy"] = false; // direct test-internal release (no real send)
    const second = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(second).toMatchObject({ reused: true });
    expect("ws" in second && second.ws).toBe(wsInst);
    expect(factory).toHaveBeenCalledTimes(1); // no new factory call
  });

  it("acquire while busy returns bypass(busy)", async () => {
    const { factory } = makeFactory();
    await pool.acquire("entry-A", "entry-A:conv-1", factory); // first acquires + holds
    const second = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(second).toEqual({ bypass: "busy" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("acquire returns bypass(no_key) when poolKey or entryId is empty", async () => {
    const { factory } = makeFactory();
    expect(await pool.acquire("", "k", factory)).toEqual({ bypass: "no_key" });
    expect(await pool.acquire("e", "", factory)).toEqual({ bypass: "no_key" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("acquire returns bypass(disabled) when pool is disabled", async () => {
    const disabled = new WsConnectionPool({ enabled: false }, { startGc: false });
    const { factory } = makeFactory();
    expect(await disabled.acquire("entry-A", "k", factory)).toEqual({ bypass: "disabled" });
    expect(factory).not.toHaveBeenCalled();
    await disabled.shutdown();
  });

  it("acquire returns bypass(cap) when entry already at max_per_account", async () => {
    const capped = new WsConnectionPool({ maxPerAccount: 2 }, { startGc: false });
    const { factory } = makeFactory();
    await capped.acquire("entry-A", "entry-A:conv-1", factory);
    await capped.acquire("entry-A", "entry-A:conv-2", factory);
    const third = await capped.acquire("entry-A", "entry-A:conv-3", factory);
    expect(third).toEqual({ bypass: "cap" });
    expect(factory).toHaveBeenCalledTimes(2);
    await capped.shutdown();
  });

  it("counts pending factories against the per-account cap", async () => {
    const capped = new WsConnectionPool({ maxPerAccount: 1 }, { startGc: false });
    let resolveFactory: ((ws: PersistentWs) => void) | undefined;
    const factory = vi.fn((deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) =>
      new Promise<PersistentWs>((resolve) => {
        resolveFactory = resolve;
      }),
    );

    const firstPromise = capped.acquire("entry-A", "entry-A:conv-1", factory);
    await nextTick();
    const second = await capped.acquire("entry-A", "entry-A:conv-2", factory);

    expect(second).toEqual({ bypass: "cap" });
    expect(factory).toHaveBeenCalledTimes(1);

    const firstDeps = factory.mock.calls[0][0];
    resolveFactory?.(new PersistentWs({
      ws: new MockWs(),
      entryId: firstDeps.entryId,
      poolKey: firstDeps.poolKey,
      hooks: firstDeps.hooks,
    }));
    await expect(firstPromise).resolves.toMatchObject({ reused: false });
    expect(capped.countByEntryId("entry-A")).toBe(1);
    await capped.shutdown();
  });

  it("releases pending capacity when a factory fails", async () => {
    const capped = new WsConnectionPool({ maxPerAccount: 1 }, { startGc: false });
    const failedFactory = vi.fn(async () => {
      throw new Error("connect failed");
    });
    await expect(
      capped.acquire("entry-A", "entry-A:conv-failed", failedFactory),
    ).rejects.toThrow("connect failed");

    const { factory } = makeFactory();
    await expect(
      capped.acquire("entry-A", "entry-A:conv-retry", factory),
    ).resolves.toMatchObject({ reused: false });
    expect(factory).toHaveBeenCalledTimes(1);
    await capped.shutdown();
  });

  it("dead connection is treated as a miss on next acquire", async () => {
    const factories: MockWs[] = [];
    const factory = vi.fn(async (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) => {
      const mock = new MockWs();
      factories.push(mock);
      return new PersistentWs({ ws: mock, entryId: deps.entryId, poolKey: deps.poolKey, hooks: deps.hooks });
    });
    await pool.acquire("entry-A", "entry-A:conv-1", factory);
    factories[0].pushClose(1006, "tcp dropped"); // simulate underlying socket dying
    expect(pool.size()).toBe(0); // onDead hook should have removed it
    const second = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(second).toMatchObject({ reused: false });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("registers a response owner only after response.completed", async () => {
    const { factory, created } = makeFactory();
    const acquired = await pool.acquire("entry-A", "entry-A:conv-1:variant-A", factory);
    if (!("ws" in acquired)) throw new Error("expected acquire success");
    const send = acquired.ws.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    const mock = created[0]["ws"] as unknown as MockWs;
    mock.pushMessage({ type: "response.created", response: { id: "resp_A" } });
    expect(pool.ownerWsId("resp_A")).toBeNull();
    mock.pushMessage({ type: "response.completed", response: { id: "resp_A" } });
    await send;
    expect(pool.ownerWsId("resp_A")).toBe(acquired.ws.id);
  });

  it("keeps only the most recent response owner per physical WS", async () => {
    const { factory, created } = makeFactory();
    const first = await pool.acquire("entry-A", "entry-A:conv-1:variant-A", factory);
    if (!("ws" in first)) throw new Error("expected acquire success");
    const mock = created[0]["ws"] as unknown as MockWs;
    const firstSend = first.ws.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    mock.pushMessage({ type: "response.completed", response: { id: "resp_A" } });
    await firstSend;
    await nextTick();

    const second = await pool.acquire("entry-A", "entry-A:conv-1:variant-A", factory);
    if (!("ws" in second)) throw new Error("expected acquire success");
    const secondSend = second.ws.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: true,
    });
    mock.pushMessage({ type: "response.completed", response: { id: "resp_B" } });
    await secondSend;

    expect(pool.ownerWsId("resp_A")).toBeNull();
    expect(pool.ownerWsId("resp_B")).toBe(second.ws.id);
  });

  it("acquireForResponse fails closed on missing, busy, dead, and account-mismatched owners", async () => {
    const { factory, created } = makeFactory();
    expect(pool.acquireForResponse("entry-A", "resp_missing")).toEqual({ bypass: "missing_owner" });

    const acquired = await pool.acquire("entry-A", "entry-A:conv-1:variant-A", factory);
    if (!("ws" in acquired)) throw new Error("expected acquire success");
    const mock = created[0]["ws"] as unknown as MockWs;
    const send = acquired.ws.send({
      request: { type: "response.create", model: "m", instructions: "", input: [] },
      signal: undefined,
      onRateLimits: undefined,
      reused: false,
    });
    mock.pushMessage({ type: "response.completed", response: { id: "resp_A" } });
    await send;
    await nextTick();

    expect(pool.acquireForResponse("entry-B", "resp_A")).toEqual({ bypass: "account_mismatch" });
    const owner = pool.acquireForResponse("entry-A", "resp_A");
    expect("ws" in owner).toBe(true);
    expect(pool.acquireForResponse("entry-A", "resp_A")).toEqual({ bypass: "busy" });
    mock.pushClose(1006, "gone");
    expect(pool.acquireForResponse("entry-A", "resp_A")).toEqual({ bypass: "missing_owner" });
  });

  it("does not let a discarded same-key factory loser remove the winning connection", async () => {
    const pending: Array<{
      deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks };
      resolve: (ws: PersistentWs) => void;
    }> = [];
    const factory = vi.fn((deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) =>
      new Promise<PersistentWs>((resolve) => pending.push({ deps, resolve })),
    );

    const firstPromise = pool.acquire("entry-A", "entry-A:conv-race", factory);
    const secondPromise = pool.acquire("entry-A", "entry-A:conv-race", factory);
    await nextTick();
    expect(pending).toHaveLength(2);

    const winner = new PersistentWs({
      ws: new MockWs(),
      entryId: pending[1].deps.entryId,
      poolKey: pending[1].deps.poolKey,
      hooks: pending[1].deps.hooks,
    });
    pending[1].resolve(winner);
    const second = await secondPromise;
    expect("ws" in second && second.ws).toBe(winner);

    const loser = new PersistentWs({
      ws: new MockWs(),
      entryId: pending[0].deps.entryId,
      poolKey: pending[0].deps.poolKey,
      hooks: pending[0].deps.hooks,
    });
    pending[0].resolve(loser);
    expect(await firstPromise).toEqual({ bypass: "busy" });
    await nextTick();

    expect(pool.size()).toBe(1);
    expect(pool.countByEntryId("entry-A")).toBe(1);
  });

  it("expires a response owner before allowing continuation", async () => {
    let now = 0;
    const expiringPool = new WsConnectionPool({ maxAgeMs: 100 }, { startGc: false });
    const mock = new MockWs();
    const factory = vi.fn(async (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) =>
      new PersistentWs({ ...deps, ws: mock, now: () => now }),
    );
    try {
      const acquired = await expiringPool.acquire("entry-A", "entry-A:conv-expire", factory);
      if (!("ws" in acquired)) throw new Error("expected acquire success");
      const sent = acquired.ws.send({
        request: { type: "response.create", model: "m", instructions: "", input: [] },
        signal: undefined,
        onRateLimits: undefined,
        reused: false,
      });
      mock.pushMessage({ type: "response.completed", response: { id: "resp_expired" } });
      await sent;
      await nextTick();
      expect(expiringPool.ownerWsId("resp_expired")).toBe(acquired.ws.id);

      now = 101;
      expect(expiringPool.acquireForResponse("entry-A", "resp_expired")).toEqual({ bypass: "expired" });
      expect(expiringPool.ownerWsId("resp_expired")).toBeNull();
      expect(expiringPool.size()).toBe(0);
    } finally {
      await expiringPool.shutdown();
    }
  });

  it("evictByEntryId closes all connections for that entry and frees the cap", async () => {
    const capped = new WsConnectionPool({ maxPerAccount: 2 }, { startGc: false });
    const { factory } = makeFactory();
    await capped.acquire("entry-A", "entry-A:conv-1", factory);
    await capped.acquire("entry-A", "entry-A:conv-2", factory);
    expect(capped.countByEntryId("entry-A")).toBe(2);
    capped.evictByEntryId("entry-A");
    expect(capped.countByEntryId("entry-A")).toBe(0);
    const next = await capped.acquire("entry-A", "entry-A:conv-3", factory);
    expect(next).toMatchObject({ reused: false });
    await capped.shutdown();
  });

  it("gcSweep skips busy entries and closes expired idle ones", async () => {
    let now = 0;
    const sweepPool = new WsConnectionPool(
      { maxAgeMs: 100 },
      { startGc: false },
    );
    const factory = vi.fn(async (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) => {
      const ws = new MockWs();
      return new PersistentWs({ ...deps, ws, now: () => now });
    });
    const r1 = await sweepPool.acquire("entry-A", "entry-A:conv-1", factory);
    if (!("ws" in r1)) throw new Error();
    // r1.ws stays busy
    const r2 = await sweepPool.acquire("entry-A", "entry-A:conv-2", factory);
    if (!("ws" in r2)) throw new Error();
    r2.ws["busy"] = false; // release r2

    now = 200; // both expired by clock
    sweepPool.gcSweep();
    // r2 is idle + expired → closed; r1 is busy → kept
    expect(r1.ws.isAlive()).toBe(true);
    expect(r2.ws.isAlive()).toBe(false);
    await sweepPool.shutdown();
  });

  it("shutdown closes all and disables further acquires", async () => {
    const { factory } = makeFactory();
    await pool.acquire("entry-A", "entry-A:conv-1", factory);
    await pool.shutdown();
    expect(pool.size()).toBe(0);
    const after = await pool.acquire("entry-A", "entry-A:conv-2", factory);
    expect(after).toEqual({ bypass: "disabled" });
  });
});

describe("singleton wiring (setWsPoolConfig + getWsPool)", () => {
  beforeEach(() => _resetWsPoolForTests());
  afterEach(() => _resetWsPoolForTests());

  it("setWsPoolConfig({enabled:false}) makes getWsPool() reject acquires", async () => {
    setWsPoolConfig({ enabled: false });
    const pool = getWsPool();
    const factory = vi.fn(async () => {
      throw new Error("factory should never run when pool is disabled");
    });
    const result = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(result).toEqual({ bypass: "disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("getWsPool() returns a default-enabled singleton when setWsPoolConfig was never called", async () => {
    const pool = getWsPool();
    const factory = vi.fn(async (deps: { entryId: string; poolKey: string; hooks: PersistentWsHooks }) => {
      const ws = new MockWs();
      return new PersistentWs({ ws, entryId: deps.entryId, poolKey: deps.poolKey, hooks: deps.hooks });
    });
    const result = await pool.acquire("entry-A", "entry-A:conv-1", factory);
    expect(result).toMatchObject({ reused: false });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("setWsPoolConfig replaces an existing singleton (later override wins)", async () => {
    setWsPoolConfig({ enabled: true });
    setWsPoolConfig({ enabled: false });
    const pool = getWsPool();
    const factory = vi.fn(async () => { throw new Error("unreachable"); });
    expect(await pool.acquire("e", "k", factory)).toEqual({ bypass: "disabled" });
  });
});
