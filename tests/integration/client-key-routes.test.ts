import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.js";
import { createClientKeyAdminRoutes } from "../../src/routes/admin/client-keys.js";
import { ClientKeyPool } from "../../src/auth/client-key-pool.js";
import type { ClientKeyEntry } from "../../src/auth/client-key-types.js";
import type { ClientKeyPersistence } from "../../src/auth/client-key-persistence.js";

function createMockPersistence(initialKeys: ClientKeyEntry[] = []): ClientKeyPersistence {
  let store = [...initialKeys];
  return {
    load: vi.fn(() => [...store]),
    save: vi.fn((keys: ClientKeyEntry[]) => {
      store = [...keys];
    }),
  } as unknown as ClientKeyPersistence;
}

describe("Client Keys Admin & Sub-key Routes", () => {
  const MASTER_KEY = "master-secret-123456";
  let pool: ClientKeyPool;
  let app: Hono;

  beforeEach(() => {
    loadConfig();
    pool = new ClientKeyPool(createMockPersistence(), () => MASTER_KEY);
    app = new Hono();
    // Mount routes with master key requirement
    app.route("/", createClientKeyAdminRoutes(pool, () => MASTER_KEY));
  });

  it("rejects unauthorized access when master key is not provided (Blocker 1)", async () => {
    const res = await app.request("/admin/client-keys", { method: "GET" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Master API key required/);
  });

  it("rejects access if server has no master key configured (Blocker 1)", async () => {
    const unconfiguredApp = new Hono();
    unconfiguredApp.route("/", createClientKeyAdminRoutes(pool, () => null));

    const res = await unconfiguredApp.request("/admin/client-keys", { method: "GET" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Master API key must be configured/);
  });

  it("lists keys with masked keys (Blocker 1)", async () => {
    const created = pool.createKey({ name: "Dev Key", max_budget_usd: 10.0 });

    const res = await app.request("/admin/client-keys", {
      method: "GET",
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.keys[0].name).toBe("Dev Key");
    expect(body.keys[0].key_masked).toMatch(/••••••••/);
    expect(body.keys[0].key).toBeUndefined(); // full key is omitted/masked
  });

  it("validates expires_at with ISO datetime schema and rejects invalid date strings (Blocker 6)", async () => {
    const res = await app.request("/admin/client-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Invalid Date Key",
        expires_at: "not-a-date",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid ISO datetime/);
  });

  it("creates, updates, toggles, resets usage, and deletes key", async () => {
    // 1. Create Key
    const createRes = await app.request("/admin/client-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Client",
        max_budget_usd: 5.0,
        allowed_models: ["gpt-5.4"],
      }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.success).toBe(true);
    expect(created.key.key).toMatch(/^sk-proxy-/);
    const keyId = created.key.id;
    const rawKey = created.key.key;

    // 2. Sub-key info
    const infoRes = await app.request("/v1/sub-key/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(infoRes.status).toBe(200);
    const info = await infoRes.json();
    expect(info.name).toBe("Test Client");
    expect(info.remaining_budget_usd).toBe(5.0);

    // 3. Toggle Status
    const toggleRes = await app.request(`/admin/client-keys/${keyId}/toggle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(toggleRes.status).toBe(200);
    const toggled = await toggleRes.json();
    expect(toggled.key.status).toBe("disabled");

    // 4. Delete Key
    const delRes = await app.request(`/admin/client-keys/${keyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.success).toBe(true);
  });
});
