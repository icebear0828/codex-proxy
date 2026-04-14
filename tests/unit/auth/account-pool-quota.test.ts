/**
 * Tests for AccountPool quota-related methods:
 * - updateCachedQuota()
 * - markQuotaExhausted()
 * - toInfo() populating cached quota
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import type { CodexQuota } from "@src/auth/types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 42,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("AccountPool quota methods", () => {
  let pool: AccountPool;

  beforeEach(() => {
    setConfigForTesting(createMockConfig());
    pool = new AccountPool({ persistence: createMemoryPersistence() });
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  describe("updateCachedQuota", () => {
    it("stores quota and timestamp on account", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a1", planType: "plus" }));
      const quota = makeQuota();

      pool.updateCachedQuota(id, quota);

      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota).toEqual(quota);
      expect(entry?.quotaFetchedAt).toBeTruthy();
    });

    it("no-ops for unknown entry", () => {
      // Should not throw
      pool.updateCachedQuota("nonexistent", makeQuota());
    });
  });

  describe("markQuotaExhausted", () => {
    it("sets status to rate_limited with reset time", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a2" }));
      const resetAt = Math.floor(Date.now() / 1000) + 7200;

      pool.markQuotaExhausted(id, resetAt);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("rate_limited");
      expect(entry?.usage.rate_limit_until).toBeTruthy();
    });

    it("uses fallback when resetAt is null", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a3" }));

      pool.markQuotaExhausted(id, null);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("rate_limited");
      expect(entry?.usage.rate_limit_until).toBeTruthy();
    });

    it("does not override disabled status", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a4" }));
      pool.markStatus(id, "disabled");

      pool.markQuotaExhausted(id, Math.floor(Date.now() / 1000) + 3600);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("disabled"); // unchanged
    });

    it("does not override expired status", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a5" }));
      pool.markStatus(id, "expired");

      pool.markQuotaExhausted(id, Math.floor(Date.now() / 1000) + 3600);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("expired"); // unchanged
    });

    it("extends rate_limit_until on already rate_limited account", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a6" }));
      // Simulate 429 backoff (short)
      pool.markRateLimited(id, { retryAfterSec: 60 });
      const entryBefore = pool.getEntry(id);
      expect(entryBefore?.status).toBe("rate_limited");
      const shortUntil = new Date(entryBefore!.usage.rate_limit_until!).getTime();

      // Quota refresh discovers exhaustion — much longer reset
      const resetAt = Math.floor(Date.now() / 1000) + 7200; // 2 hours
      pool.markQuotaExhausted(id, resetAt);

      const entryAfter = pool.getEntry(id);
      expect(entryAfter?.status).toBe("rate_limited");
      const longUntil = new Date(entryAfter!.usage.rate_limit_until!).getTime();
      expect(longUntil).toBeGreaterThan(shortUntil);
    });

    it("does not shorten existing rate_limit_until", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a7" }));
      // Mark with long reset (e.g. 7-day quota)
      const longResetAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
      pool.markQuotaExhausted(id, longResetAt);

      const entryBefore = pool.getEntry(id);
      const originalUntil = entryBefore!.usage.rate_limit_until;

      // Try to mark with shorter reset (e.g. 5-hour quota)
      const shortResetAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      pool.markQuotaExhausted(id, shortResetAt);

      const entryAfter = pool.getEntry(id);
      expect(entryAfter!.usage.rate_limit_until).toBe(originalUntil); // unchanged
    });
  });

  describe("toInfo with cached quota", () => {
    it("populates quota field from cachedQuota", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a8", planType: "team" }));
      const quota = makeQuota({ plan_type: "team" });

      pool.updateCachedQuota(id, quota);

      const accounts = pool.getAccounts();
      const acct = accounts.find((a) => a.id === id);
      expect(acct?.quota).toEqual(quota);
      expect(acct?.quotaFetchedAt).toBeTruthy();
    });

    it("does not include quota when cachedQuota is null", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a9" }));

      const accounts = pool.getAccounts();
      const acct = accounts.find((a) => a.id === id);
      expect(acct?.quota).toBeUndefined();
    });
  });

  describe("acquire skips exhausted accounts", () => {
    it("skips rate_limited (quota exhausted) account", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "b1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "b2" }));

      // Exhaust first account
      pool.markQuotaExhausted(id1, Math.floor(Date.now() / 1000) + 7200);

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("returns null when all accounts exhausted", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "c1" }));
      pool.markQuotaExhausted(id1, Math.floor(Date.now() / 1000) + 7200);

      const acquired = pool.acquire();
      expect(acquired).toBeNull();
    });
  });
});
