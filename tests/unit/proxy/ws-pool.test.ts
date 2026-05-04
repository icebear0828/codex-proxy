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

  send(data: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
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

function newPersistentWs(opts: { hooks?: Partial<PersistentWsHooks>; entryId?: string; poolKey?: string } = {}) {
  const ws = new MockWs();
  const onDead = vi.fn();
  const persistent = new PersistentWs({
    ws,
    entryId: opts.entryId ?? "entry-A",
    poolKey: opts.poolKey ?? "entry-A:conv-1",
    hooks: { onDead, ...opts.hooks },
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

  it("send resolves Response on first non-internal frame and streams subsequent events", async () => {
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
    const resp = await promise;
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    ws.pushMessage({ type: "response.output_text.delta", delta: "hi" });
    ws.pushMessage({ type: "response.completed" });
    const text = await resp.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
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
    const resp = await promise;
    ws.pushMessage({ type: "response.completed" });
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
    const resp = await promise;
    expect(resp.headers.get("x-codex-primary-used-percent")).toBe("42");
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
