import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../../../src/config.js";
import { apiKeyAuth } from "../../../src/middleware/api-key-auth.js";
import { ClientKeyPool } from "../../../src/auth/client-key-pool.js";
import type { AccountPool } from "../../../src/auth/account-pool.js";
import type { ClientKeyEntry } from "../../../src/auth/client-key-types.js";
import type { ClientKeyPersistence } from "../../../src/auth/client-key-persistence.js";

function createMockPersistence(initialKeys: ClientKeyEntry[] = []): ClientKeyPersistence {
  let store = [...initialKeys];
  return {
    load: vi.fn(() => [...store]),
    save: vi.fn((keys: ClientKeyEntry[]) => {
      store = [...keys];
    }),
  } as unknown as ClientKeyPersistence;
}

describe("apiKeyAuth with ClientKeyPool & Stream Concurrency (Blocker 2)", () => {
  const MASTER_KEY = "master-super-secret-key";
  let pool: ClientKeyPool;
  let mockAccountPool: AccountPool;

  beforeEach(() => {
    loadConfig();
    pool = new ClientKeyPool(createMockPersistence(), () => MASTER_KEY);
    mockAccountPool = {
      isAuthDisabled: vi.fn(() => false),
      validateProxyApiKey: vi.fn((key: string) => key === MASTER_KEY),
    } as unknown as AccountPool;
  });

  it("binds concurrency slot to stream completion rather than handler return", async () => {
    const key = pool.createKey({
      name: "Single Concurrency Stream Key",
      max_concurrency: 1,
    });

    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const app = new Hono();
    app.use("/v1/*", apiKeyAuth(mockAccountPool, pool));

    app.post("/v1/chat/stream", (c) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    // 1. First stream request starts
    const res1 = await app.request("/v1/chat/stream", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
    });
    expect(res1.status).toBe(200);

    // 2. Second concurrent stream request while first is still open -> MUST BE 429
    const res2 = await app.request("/v1/chat/stream", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
    });
    expect(res2.status).toBe(429);
    const body2 = await res2.json();
    expect(body2.error.code).toBe("concurrency_limit_exceeded");

    // 3. First stream closes
    streamController!.close();
    // Read the stream to trigger close in consumer
    const reader = res1.body?.getReader();
    await reader?.read();

    // 4. Now that stream 1 is closed, third request must succeed
    const res3 = await app.request("/v1/chat/stream", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
    });
    expect(res3.status).toBe(200);
  });

  it("releases slot immediately for non-streaming json responses", async () => {
    const key = pool.createKey({
      name: "Non-stream Key",
      max_concurrency: 1,
    });

    const app = new Hono();
    app.use("/v1/*", apiKeyAuth(mockAccountPool, pool));
    app.post("/v1/chat/completions", (c) => c.json({ result: "ok" }));

    const res1 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}` },
    });
    expect(res2.status).toBe(200);
  });
});
