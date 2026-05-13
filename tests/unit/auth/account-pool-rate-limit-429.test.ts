/**
 * Tests for AccountPool.applyRateLimit429 — the new single-source-of-truth
 * path for handling upstream 429 responses. Writes into cachedQuota instead
 * of mutating status/rate_limit_until, so the dual-truth bug between local
 * lock and upstream quota window can no longer arise.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { hasReachedCachedQuota } from "@src/auth/quota-skip.js";
import type { CodexQuota } from "@src/auth/types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 42,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 18000,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("AccountPool.applyRateLimit429", () => {
  let pool: AccountPool;

  beforeEach(() => {
    setConfigForTesting(createMockConfig());
    pool = new AccountPool({ persistence: createMemoryPersistence() });
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("writes limit_reached=true and reset_at into primary cachedQuota.rate_limit", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a1", planType: "plus" }));
    const before = Math.floor(Date.now() / 1000);

    pool.applyRateLimit429(id, { retryAfterSec: 600 });

    const entry = pool.getEntry(id);
    expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(true);
    expect(entry?.cachedQuota?.rate_limit.used_percent).toBeGreaterThanOrEqual(100);
    // 20% jitter applied to retry-after to spread retries; allow a wide window.
    const resetAt = entry?.cachedQuota?.rate_limit.reset_at ?? 0;
    expect(resetAt).toBeGreaterThanOrEqual(before + 600 * 0.8 - 1);
    expect(resetAt).toBeLessThanOrEqual(before + 600 * 1.2 + 1);
  });

  it("synthesizes cachedQuota when account has none yet", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a2", planType: "plus" }));
    expect(pool.getEntry(id)?.cachedQuota).toBeNull();

    pool.applyRateLimit429(id, { retryAfterSec: 300 });

    const entry = pool.getEntry(id);
    expect(entry?.cachedQuota).not.toBeNull();
    expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(true);
    expect(entry?.cachedQuota?.plan_type).toBe("plus");
  });

  it("prefers existing reset_at when it is further in the future (don't shrink lock)", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a3", planType: "plus" }));
    const farFuture = Math.floor(Date.now() / 1000) + 36000;
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: farFuture,
        limit_window_seconds: 18000,
      },
    }));

    pool.applyRateLimit429(id, { retryAfterSec: 60 });

    const entry = pool.getEntry(id);
    expect(entry?.cachedQuota?.rate_limit.reset_at).toBe(farFuture);
    expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(true);
  });

  it("uses resetsAtSec when provided in preference to retryAfterSec", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a4", planType: "plus" }));
    const explicit = Math.floor(Date.now() / 1000) + 1234;

    pool.applyRateLimit429(id, { retryAfterSec: 60, resetsAtSec: explicit });

    const entry = pool.getEntry(id);
    expect(entry?.cachedQuota?.rate_limit.reset_at).toBe(explicit);
  });

  it("excludes the account from hasAvailableAccounts via hasReachedCachedQuota", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a5", planType: "plus" }));
    expect(pool.hasAvailableAccounts()).toBe(true);

    pool.applyRateLimit429(id, { retryAfterSec: 600 });

    const entry = pool.getEntry(id);
    expect(hasReachedCachedQuota(entry!)).toBe(true);
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("does not mutate status (kept as 'active' so the field stays a pure rotation marker)", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a6", planType: "plus" }));
    expect(pool.getEntry(id)?.status).toBe("active");

    pool.applyRateLimit429(id, { retryAfterSec: 600 });

    expect(pool.getEntry(id)?.status).toBe("active");
  });

  it("no-ops for unknown entry", () => {
    expect(() => pool.applyRateLimit429("nonexistent", { retryAfterSec: 60 })).not.toThrow();
  });

  it("counts the request when countRequest=true", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a7", planType: "plus" }));
    const before = pool.getEntry(id)?.usage.request_count ?? 0;

    pool.applyRateLimit429(id, { retryAfterSec: 60, countRequest: true });

    expect(pool.getEntry(id)?.usage.request_count).toBe(before + 1);
    expect(pool.getEntry(id)?.usage.window_request_count).toBe(1);
  });

  it("after reset_at passes, refreshStatus auto-clears limit_reached via resetExpiredQuotaWindow", () => {
    const id = pool.addAccount(createValidJwt({ accountId: "a8", planType: "plus" }));
    // Apply a 429 with very short retry-after, then advance the wallclock past it.
    const pastResetAt = Math.floor(Date.now() / 1000) - 10;
    pool.applyRateLimit429(id, { resetsAtSec: pastResetAt });
    // Existing entry should currently look limited even though reset_at is in the past
    // until refreshStatus runs (which is called inside hasAvailableAccounts).

    const available = pool.hasAvailableAccounts();

    // After refreshStatus → resetExpiredQuotaWindow ran, limit_reached should be false again
    const entry = pool.getEntry(id);
    expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(false);
    expect(available).toBe(true);
  });
});
