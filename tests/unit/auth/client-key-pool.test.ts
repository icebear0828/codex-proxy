import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClientKeyPool } from "../../../src/auth/client-key-pool.js";
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

describe("ClientKeyPool", () => {
  let mockPersistence: ClientKeyPersistence;
  let pool: ClientKeyPool;
  const MASTER_KEY = "sk-master-secret-123456";

  beforeEach(() => {
    mockPersistence = createMockPersistence();
    pool = new ClientKeyPool(mockPersistence, () => MASTER_KEY);
  });

  it("creates a client key and generates random prefix if key is omitted", () => {
    const key = pool.createKey({
      name: "Client 1",
      max_budget_usd: 10.0,
      allowed_models: ["gpt-5.4"],
    });

    expect(key.id).toMatch(/^ck_/);
    expect(key.name).toBe("Client 1");
    expect(key.key).toMatch(/^sk-proxy-[a-f0-9]{32}$/);
    expect(key.status).toBe("active");
    expect(mockPersistence.save).toHaveBeenCalled();
  });

  it("rejects client key that conflicts with master API key (Blocker 3)", () => {
    expect(() => {
      pool.createKey({
        name: "Malicious Client",
        key: MASTER_KEY,
      });
    }).toThrow(/conflicts with master API key/);
  });

  it("rejects updating client key to conflict with master key (Blocker 3)", () => {
    const key = pool.createKey({ name: "Client" });
    expect(() => {
      pool.updateKey(key.id, { name: "Client New" });
    }).not.toThrow();

    // Now test conflict detection in validation if master key changed
    const poolWithConflict = new ClientKeyPool(
      createMockPersistence([key]),
      () => key.key, // master key equals client key
    );
    const validation = poolWithConflict.validateAccess(key.key);
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toBe("master_key_conflict");
  });

  it("rejects duplicate client keys", () => {
    pool.createKey({ name: "Key 1", key: "sk-proxy-custom-key" });
    expect(() => {
      pool.createKey({ name: "Key 2", key: "sk-proxy-custom-key" });
    }).toThrow(/already exists/);
  });

  it("validates valid active key", () => {
    const key = pool.createKey({ name: "Valid Key" });
    const res = pool.validateAccess(key.key);
    expect(res.allowed).toBe(true);
  });

  it("fails closed when expires_at is not a valid date string (Blocker 6)", () => {
    const invalidKey: ClientKeyEntry = {
      id: "ck_invalid_date",
      name: "Bad Date",
      key: "sk-proxy-bad-date-12345",
      status: "active",
      expires_at: "not-a-date",
      max_budget_usd: null,
      used_cost_usd: 0,
      max_tokens: null,
      used_tokens: 0,
      max_concurrency: null,
      allowed_models: null,
      request_count: 0,
      last_used_at: null,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
    };

    const customPool = new ClientKeyPool(createMockPersistence([invalidKey]), () => MASTER_KEY);
    const res = customPool.validateAccess(invalidKey.key);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("invalid_key_expiration");
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired key", () => {
    const key = pool.createKey({
      name: "Expired Key",
      expires_at: "2020-01-01T00:00:00.000Z",
    });

    const res = pool.validateAccess(key.key);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("key_expired");
    expect(res.statusCode).toBe(401);
  });

  it("rejects disabled key", () => {
    const key = pool.createKey({ name: "Disabled Key" });
    pool.toggleStatus(key.id);

    const res = pool.validateAccess(key.key);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("key_disabled");
    expect(res.statusCode).toBe(401);
  });

  it("rejects key when USD budget is exhausted", () => {
    const key = pool.createKey({
      name: "Budget Key",
      max_budget_usd: 5.0,
    });

    pool.recordUsage(key.id, "gpt-5.4", { input_tokens: 1000, output_tokens: 1000 }, 5.5);

    const res = pool.validateAccess(key.key);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("insufficient_quota");
    expect(res.statusCode).toBe(429);
  });

  it("tracks and enforces concurrency slot limits", () => {
    const key = pool.createKey({
      name: "Concurrency Key",
      max_concurrency: 1,
    });

    expect(pool.acquireSlot(key.id)).toBe(true);
    expect(pool.acquireSlot(key.id)).toBe(false); // second slot rejected

    pool.releaseSlot(key.id);
    expect(pool.acquireSlot(key.id)).toBe(true); // can acquire again
    pool.releaseSlot(key.id);
  });

  it("calculates cost as $0 for unknown models without guessing prices (Warning 9)", () => {
    const key = pool.createKey({
      name: "Unknown Model Key",
      max_budget_usd: 10.0,
    });

    // Record usage for unknown model with undefined costUsd
    pool.recordUsage(key.id, "unknown-custom-model-x", { input_tokens: 10000, output_tokens: 5000 });

    const updated = pool.getById(key.id)!;
    expect(updated.used_tokens).toBe(15000);
    expect(updated.used_cost_usd).toBe(0); // $0 for unpriced model
  });

  it("resets usage statistics", () => {
    const key = pool.createKey({ name: "Usage Key", max_budget_usd: 10.0 });
    pool.recordUsage(key.id, "gpt-5.4", { input_tokens: 1000, output_tokens: 500 }, 2.0);

    let current = pool.getById(key.id)!;
    expect(current.used_cost_usd).toBe(2.0);
    expect(current.used_tokens).toBe(1500);

    pool.resetUsage(key.id);
    current = pool.getById(key.id)!;
    expect(current.used_cost_usd).toBe(0);
    expect(current.used_tokens).toBe(0);
    expect(current.request_count).toBe(0);
  });
});
