/**
 * Tests for sticky rotation strategy in AccountPool.
 *
 * Sticky: prefer the most recently used account, keeping it in use
 * until rate-limited or quota-exhausted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createMockConfig } from "@helpers/config.js";
import { createValidJwt } from "@helpers/jwt.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { getModelPlanTypes } from "@src/models/model-store.js";

// Only model-store needs mocking (for model-aware selection test)
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
  getModelInfo: vi.fn(() => null),
  parseModelName: vi.fn((m: string) => ({ modelId: m, serviceTier: null, reasoningEffort: null })),
}));

describe("account-pool sticky strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfigForTesting(createMockConfig({ auth: { rotation_strategy: "sticky" } }));
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("selects account with most recent last_used", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));
    const idC = pool.addAccount(createValidJwt({ accountId: "c", email: "c@test.com", planType: "free" }));

    // Simulate: B was used most recently, then A, then C
    pool.getEntry(idC)!.usage.last_used = new Date(Date.now() - 30_000).toISOString();
    pool.getEntry(idC)!.usage.request_count = 1;

    pool.getEntry(idA)!.usage.last_used = new Date(Date.now() - 10_000).toISOString();
    pool.getEntry(idA)!.usage.request_count = 2;

    pool.getEntry(idB)!.usage.last_used = new Date(Date.now() - 1_000).toISOString();
    pool.getEntry(idB)!.usage.request_count = 5;

    // Sticky should pick B (most recent last_used) despite having most requests
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("sticks to same account across multiple acquire/release cycles", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // First acquire picks one (arbitrary from fresh pool)
    const first = pool.acquire()!;
    pool.release(first.entryId);

    // Subsequent acquires should stick to the same account
    for (let i = 0; i < 5; i++) {
      const next = pool.acquire()!;
      expect(next.entryId).toBe(first.entryId);
      pool.release(next.entryId);
    }
  });

  it("falls back when current account is rate-limited", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // Make A the sticky choice
    pool.getEntry(idA)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idA)!.usage.request_count = 5;

    // Rate-limit A
    pool.markRateLimited(idA, { retryAfterSec: 300 });

    // Should fall back to B
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("picks first available when no account has been used yet", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));
    pool.addAccount(createValidJwt({ accountId: "c", email: "c@test.com", planType: "free" }));

    // All accounts have null last_used — should pick one
    const first = pool.acquire();
    expect(first).not.toBeNull();
    pool.release(first!.entryId);

    // After releasing, the same one should be sticky
    const second = pool.acquire();
    expect(second).not.toBeNull();
    expect(second!.entryId).toBe(first!.entryId);
    pool.release(second!.entryId);
  });

  it("respects model filtering", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idFree = pool.addAccount(createValidJwt({ accountId: "free1", email: "free@test.com", planType: "free" }));
    const idTeam = pool.addAccount(createValidJwt({ accountId: "team1", email: "team@test.com", planType: "team" }));

    // Use the free account more recently
    pool.getEntry(idFree)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idFree)!.usage.request_count = 10;

    // Model requires team plan — sticky should pick team account despite free being more recent
    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idTeam);
    pool.release(acquired!.entryId);
  });

  it("least_used still works (regression guard)", () => {
    setConfigForTesting(createMockConfig({ auth: { rotation_strategy: "least_used" } }));

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idA = pool.addAccount(createValidJwt({ accountId: "a", email: "a@test.com", planType: "free" }));
    const idB = pool.addAccount(createValidJwt({ accountId: "b", email: "b@test.com", planType: "free" }));

    // A has more requests — least_used should prefer B
    pool.getEntry(idA)!.usage.request_count = 10;
    pool.getEntry(idA)!.usage.last_used = new Date().toISOString();
    pool.getEntry(idB)!.usage.request_count = 2;

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });
});
