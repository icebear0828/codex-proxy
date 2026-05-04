/**
 * Integration test: pool reuses the same physical WebSocket across N turns.
 *
 * Uses a real local `ws.Server` (no mocks) and the actual
 * `createWebSocketResponse` codepath. Drives 5 sequential `response.create`
 * requests through the pool and asserts that the server only saw a single
 * `connection` event. This locks in the LB-affinity property the pool
 * exists to provide.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startLocalWsServer, type LocalWsServerHandle } from "@helpers/ws-server.js";
import { createWebSocketResponse, type WsCreateRequest } from "@src/proxy/ws-transport.js";
import { WsConnectionPool, _resetWsPoolForTests } from "@src/proxy/ws-pool.js";

const baseRequest: WsCreateRequest = {
  type: "response.create",
  model: "gpt-test",
  instructions: "be brief",
  input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
};

async function drainResponse(resp: Response): Promise<string> {
  // Read the SSE stream completely so the underlying ReadableStream is
  // closed and the pool entry's `busy` flag clears for the next caller.
  const reader = resp.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("ws-pool integration: persistent connection reuse", () => {
  let server: LocalWsServerHandle;
  let pool: WsConnectionPool;

  beforeEach(async () => {
    _resetWsPoolForTests();
    server = await startLocalWsServer();
    pool = new WsConnectionPool({ enabled: true, maxAgeMs: 60_000, maxPerAccount: 8 }, { startGc: false });
  });

  afterEach(async () => {
    await pool.shutdown();
    await server.close();
    _resetWsPoolForTests();
  });

  it("5 sequential turns on same (entryId, conversationId) reuse a single WS connection", async () => {
    const poolKey = "entry-A:conv-1";
    const entryId = "entry-A";

    for (let turn = 1; turn <= 5; turn++) {
      const resp = await createWebSocketResponse(
        server.url,
        {},
        { ...baseRequest, instructions: `turn-${turn}` },
        undefined,
        null,
        undefined,
        { pool, entryId, poolKey },
      );
      expect(resp.status).toBe(200);
      const text = await drainResponse(resp);
      expect(text).toContain("event: response.completed");
    }

    expect(server.connectionCount()).toBe(1);
    expect(pool.size()).toBe(1);
  });

  it("different conversations open different connections (one per pool key)", async () => {
    const entryId = "entry-A";

    for (let conv = 1; conv <= 3; conv++) {
      const resp = await createWebSocketResponse(
        server.url,
        {},
        baseRequest,
        undefined,
        null,
        undefined,
        { pool, entryId, poolKey: `${entryId}:conv-${conv}` },
      );
      await drainResponse(resp);
    }

    expect(server.connectionCount()).toBe(3);
    expect(pool.size()).toBe(3);
    expect(pool.countByEntryId(entryId)).toBe(3);
  });

  it("server-side disconnect evicts pool entry; next acquire reconnects fresh", async () => {
    const entryId = "entry-A";
    const poolKey = `${entryId}:conv-1`;

    const r1 = await createWebSocketResponse(
      server.url, {}, baseRequest, undefined, null, undefined,
      { pool, entryId, poolKey },
    );
    await drainResponse(r1);
    expect(server.connectionCount()).toBe(1);
    expect(pool.size()).toBe(1);

    server.closeAllSockets(1000, "simulated server drop");
    // Allow the close event to propagate through PersistentWs → pool eviction.
    // Poll until evicted (avoids relying on a fixed sleep duration).
    const start = Date.now();
    while (pool.size() > 0 && Date.now() - start < 1000) {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(pool.size()).toBe(0);

    const r2 = await createWebSocketResponse(
      server.url, {}, baseRequest, undefined, null, undefined,
      { pool, entryId, poolKey },
    );
    await drainResponse(r2);
    expect(server.connectionCount()).toBe(2);
    expect(pool.size()).toBe(1);
  });

  it("disabled pool falls back to one-shot connections (every turn opens a new socket)", async () => {
    const disabled = new WsConnectionPool({ enabled: false }, { startGc: false });
    try {
      for (let turn = 1; turn <= 3; turn++) {
        const resp = await createWebSocketResponse(
          server.url, {}, baseRequest, undefined, null, undefined,
          { pool: disabled, entryId: "entry-A", poolKey: "entry-A:conv-1" },
        );
        await drainResponse(resp);
      }
      expect(server.connectionCount()).toBe(3);
      expect(disabled.size()).toBe(0);
    } finally {
      await disabled.shutdown();
    }
  });

  it("evictByEntryId closes pooled WS; subsequent acquire opens fresh", async () => {
    const entryId = "entry-A";

    const r1 = await createWebSocketResponse(
      server.url, {}, baseRequest, undefined, null, undefined,
      { pool, entryId, poolKey: `${entryId}:conv-1` },
    );
    await drainResponse(r1);
    expect(pool.countByEntryId(entryId)).toBe(1);

    pool.evictByEntryId(entryId);
    // closeGracefully is async (queueMicrotask close emit + onDead hook).
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(pool.countByEntryId(entryId)).toBe(0);

    const r2 = await createWebSocketResponse(
      server.url, {}, baseRequest, undefined, null, undefined,
      { pool, entryId, poolKey: `${entryId}:conv-1` },
    );
    await drainResponse(r2);
    expect(server.connectionCount()).toBe(2);
  });
});

describe("ws-pool integration: backward compat (no poolCtx)", () => {
  let server: LocalWsServerHandle;

  beforeEach(async () => {
    server = await startLocalWsServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("createWebSocketResponse without poolCtx behaves exactly like the old one-shot path", async () => {
    for (let turn = 1; turn <= 3; turn++) {
      const resp = await createWebSocketResponse(server.url, {}, baseRequest);
      await drainResponse(resp);
    }
    // Each call opens a fresh connection — proves poolCtx-less callers are
    // unaffected by the pool integration.
    expect(server.connectionCount()).toBe(3);
  });
});
