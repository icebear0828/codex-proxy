/**
 * Integration tests for multi-account routing logic in AccountPool.
 * Tests plan-aware routing, rotation strategies, rate limiting, and lock management.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock fs before importing AccountPool
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

// Mock paths
vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

// Mock config
vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    model: {
      default: "gpt-5.2-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
    },
    server: { proxy_api_key: null },
  })),
}));

// Mock model store
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
  loadStaticModels: vi.fn(),
}));

// Mock model fetcher
vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

// Mock jitter to return exact value
vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { getConfig } from "@src/config.js";
import { getModelPlanTypes } from "@src/models/model-store.js";
import { createValidJwt } from "@helpers/jwt.js";

describe("account-routing integration", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      auth: {
        jwt_token: null,
        rotation_strategy: "least_used",
        rate_limit_backoff_seconds: 60,
      },
      model: {
        default: "gpt-5.2-codex",
        default_reasoning_effort: null,
        default_service_tier: null,
      },
      server: { proxy_api_key: null },
    } as ReturnType<typeof getConfig>);
    vi.mocked(getModelPlanTypes).mockReturnValue([]);
    pool = new AccountPool();
  });

  afterEach(() => {
    pool.destroy();
  });

  it("plan-aware routing: prefers matching plan", () => {
    const freeToken = createValidJwt({ accountId: "acct-free-1", planType: "free" });
    const plusToken = createValidJwt({ accountId: "acct-plus-1", planType: "plus" });

    pool.addAccount(freeToken);
    pool.addAccount(plusToken);

    vi.mocked(getModelPlanTypes).mockReturnValue(["plus"]);

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    // The acquired account should be the plus one
    const entry = pool.getEntry(acquired!.entryId);
    expect(entry).toBeDefined();
    expect(entry!.planType).toBe("plus");
  });

  it("plan-aware routing: returns null when no plan matches", () => {
    const freeToken = createValidJwt({ accountId: "acct-free-2", planType: "free" });
    pool.addAccount(freeToken);

    vi.mocked(getModelPlanTypes).mockReturnValue(["plus"]);

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).toBeNull();
  });

  it("fallback when plan map empty", () => {
    const tokenA = createValidJwt({ accountId: "acct-a-1", planType: "free" });
    const tokenB = createValidJwt({ accountId: "acct-b-1", planType: "plus" });

    pool.addAccount(tokenA);
    pool.addAccount(tokenB);

    vi.mocked(getModelPlanTypes).mockReturnValue([]);

    // When no plan constraint, any account is a candidate
    const acquired = pool.acquire({ model: "gpt-5.2-codex" });
    expect(acquired).not.toBeNull();
  });

  it("least-used rotation", () => {
    const tokenA = createValidJwt({ accountId: "acct-lu-1", planType: "free" });
    const tokenB = createValidJwt({ accountId: "acct-lu-2", planType: "free" });
    const tokenC = createValidJwt({ accountId: "acct-lu-3", planType: "free" });

    pool.addAccount(tokenA);
    pool.addAccount(tokenB);
    pool.addAccount(tokenC);

    // Acquire and release each once to establish usage
    const a1 = pool.acquire()!;
    pool.release(a1.entryId, { input_tokens: 10, output_tokens: 5 });

    const a2 = pool.acquire()!;
    pool.release(a2.entryId, { input_tokens: 10, output_tokens: 5 });

    const a3 = pool.acquire()!;
    pool.release(a3.entryId, { input_tokens: 10, output_tokens: 5 });

    // Now all have request_count=1; acquire again — use the a1 twice to bump its count
    const extra = pool.acquire()!;
    pool.release(extra.entryId, { input_tokens: 10, output_tokens: 5 });

    // The next acquire should skip the one with count=2 and pick one with count=1
    const next = pool.acquire()!;
    const nextEntry = pool.getEntry(next.entryId)!;
    expect(nextEntry.usage.request_count).toBe(1);
    pool.release(next.entryId);
  });

  it("round-robin rotation", () => {
    vi.mocked(getConfig).mockReturnValue({
      auth: {
        jwt_token: null,
        rotation_strategy: "round_robin",
        rate_limit_backoff_seconds: 60,
      },
      model: {
        default: "gpt-5.2-codex",
        default_reasoning_effort: null,
        default_service_tier: null,
      },
      server: { proxy_api_key: null },
    } as ReturnType<typeof getConfig>);

    const rrPool = new AccountPool();
    const tokenA = createValidJwt({ accountId: "acct-rr-1", planType: "free" });
    const tokenB = createValidJwt({ accountId: "acct-rr-2", planType: "free" });

    rrPool.addAccount(tokenA);
    rrPool.addAccount(tokenB);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const acq = rrPool.acquire()!;
      ids.push(acq.entryId);
      rrPool.release(acq.entryId);
    }

    // Should alternate: a, b, a, b
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[1]);

    rrPool.destroy();
  });

  it("rate limited account skipped", () => {
    const tokenA = createValidJwt({ accountId: "acct-rl-1", planType: "free" });
    const tokenB = createValidJwt({ accountId: "acct-rl-2", planType: "free" });

    const idA = pool.addAccount(tokenA);
    pool.addAccount(tokenB);

    // Acquire A and mark it rate limited
    const acqA = pool.acquire()!;
    expect(acqA.entryId).toBe(idA);
    pool.markRateLimited(acqA.entryId);

    // Next acquire should skip A and return B
    const acqB = pool.acquire()!;
    expect(acqB.entryId).not.toBe(idA);
  });

  it("rate limited auto-recovery", async () => {
    const token = createValidJwt({ accountId: "acct-rec-1", planType: "free" });
    const id = pool.addAccount(token);

    const acq = pool.acquire()!;
    expect(acq.entryId).toBe(id);

    // Mark rate limited with very short backoff (negative = already expired)
    pool.markRateLimited(acq.entryId, { retryAfterSec: -1 });

    // Should auto-recover immediately since backoff has passed
    const recovered = pool.acquire();
    expect(recovered).not.toBeNull();
    expect(recovered!.entryId).toBe(id);
  });

  it("stale lock auto-release", () => {
    const token = createValidJwt({ accountId: "acct-lock-1", planType: "free" });
    pool.addAccount(token);

    const acquired = pool.acquire()!;

    // Manually set the lock timestamp to 6 minutes ago
    const lifecycle = (pool as unknown as { lifecycle: { acquireLocks: Map<string, number[]> } }).lifecycle;
    const locks = lifecycle.acquireLocks;
    locks.set(acquired.entryId, [Date.now() - 6 * 60 * 1000]);

    // acquire again should auto-release the stale lock and return the same account
    const reacquired = pool.acquire();
    expect(reacquired).not.toBeNull();
    expect(reacquired!.entryId).toBe(acquired.entryId);
  });

  it("excludeIds", () => {
    const tokenA = createValidJwt({ accountId: "acct-ex-1", planType: "free" });
    const tokenB = createValidJwt({ accountId: "acct-ex-2", planType: "free" });

    const idA = pool.addAccount(tokenA);
    pool.addAccount(tokenB);

    const acquired = pool.acquire({ excludeIds: [idA] });
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).not.toBe(idA);
  });

  it("empty response tracking", () => {
    const token = createValidJwt({ accountId: "acct-empty-1", planType: "free" });
    const id = pool.addAccount(token);

    const acq = pool.acquire()!;
    pool.release(acq.entryId);

    pool.recordEmptyResponse(id);
    pool.recordEmptyResponse(id);

    const entry = pool.getEntry(id);
    expect(entry).toBeDefined();
    expect(entry!.usage.empty_response_count).toBe(2);
  });
});
