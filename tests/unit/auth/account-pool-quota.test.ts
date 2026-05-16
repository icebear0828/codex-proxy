/**
 * Tests for AccountPool quota-related methods:
 * - updateCachedQuota()
 * - applyRateLimit429() (replaces the retired markQuotaExhausted/markRateLimited)
 * - toInfo() populating cached quota
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

    it("preserves existing credits when new quota lacks them (header-driven passive update)", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "credits-1", planType: "pro" }));
      // First write: full quota WITH credits (from /codex/usage body, toQuota path).
      pool.updateCachedQuota(id, makeQuota({
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: 99.5 },
      }));
      // Second write: header-driven quota without credits (rateLimitToQuota path).
      // Must preserve the previously known balance, not wipe it.
      pool.updateCachedQuota(id, makeQuota({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          used_percent: 60,
          reset_at: Math.floor(Date.now() / 1000) + 1800,
          limit_window_seconds: 3600,
        },
      }));
      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota?.credits).toEqual({
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: 99.5,
      });
      expect(entry?.cachedQuota?.rate_limit.used_percent).toBe(60);
    });

    it("overwrites credits when new quota explicitly provides them", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "credits-2", planType: "pro" }));
      pool.updateCachedQuota(id, makeQuota({
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: 100 },
      }));
      pool.updateCachedQuota(id, makeQuota({
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: 42 },
      }));
      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota?.credits?.balance).toBe(42);
    });
  });

  describe("applyRateLimit429 (replaces markQuotaExhausted)", () => {
    it("marks primary cachedQuota.rate_limit as limit_reached with provided reset_at", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a2" }));
      const resetAt = Math.floor(Date.now() / 1000) + 7200;

      pool.applyRateLimit429(id, { resetsAtSec: resetAt });

      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(true);
      expect(entry?.cachedQuota?.rate_limit.reset_at).toBe(resetAt);
      expect(hasReachedCachedQuota(entry!)).toBe(true);
    });

    it("uses default backoff when no retry/reset hint provided", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a3" }));

      pool.applyRateLimit429(id);

      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota?.rate_limit.limit_reached).toBe(true);
      expect(entry?.cachedQuota?.rate_limit.reset_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("does not override disabled status (account stays disabled)", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a4" }));
      pool.markStatus(id, "disabled");

      pool.applyRateLimit429(id, { resetsAtSec: Math.floor(Date.now() / 1000) + 3600 });

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("disabled");
    });

    it("does not override expired status", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a5" }));
      pool.markStatus(id, "expired");

      pool.applyRateLimit429(id, { resetsAtSec: Math.floor(Date.now() / 1000) + 3600 });

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("expired");
    });

    it("extends existing lock — never shrinks reset_at when re-applied", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a6" }));

      // First 429 with short retry-after
      pool.applyRateLimit429(id, { retryAfterSec: 60 });
      const shortResetAt = pool.getEntry(id)!.cachedQuota!.rate_limit.reset_at!;

      // Second 429 (e.g. discovered weekly bucket exhausted) with much longer reset
      const longResetAt = Math.floor(Date.now() / 1000) + 7200;
      pool.applyRateLimit429(id, { resetsAtSec: longResetAt });

      expect(pool.getEntry(id)!.cachedQuota!.rate_limit.reset_at).toBe(longResetAt);
      expect(longResetAt).toBeGreaterThan(shortResetAt);
    });

    it("does not shrink existing reset_at when a shorter 429 arrives", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a7" }));
      const longResetAt = Math.floor(Date.now() / 1000) + 86400;
      pool.applyRateLimit429(id, { resetsAtSec: longResetAt });

      // Shorter retry-after should NOT replace the longer lock
      const shortResetAt = Math.floor(Date.now() / 1000) + 3600;
      pool.applyRateLimit429(id, { resetsAtSec: shortResetAt });

      expect(pool.getEntry(id)!.cachedQuota!.rate_limit.reset_at).toBe(longResetAt);
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

    it("keeps cached quota visible after the primary reset time passes", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "a10", planType: "plus" }));
      const nowSec = Math.floor(Date.now() / 1000);

      pool.updateCachedQuota(id, makeQuota({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          used_percent: 87,
          reset_at: nowSec - 10,
          limit_window_seconds: 3600,
        },
        secondary_rate_limit: {
          limit_reached: false,
          used_percent: 33,
          reset_at: nowSec + 7200,
          limit_window_seconds: 604800,
        },
      }));

      const accounts = pool.getAccounts();
      const acct = accounts.find((a) => a.id === id);

      expect(acct?.quota).toBeDefined();
      expect(acct?.quota?.rate_limit.used_percent).toBe(0);
      expect(acct?.quota?.rate_limit.limit_reached).toBe(false);
      expect(acct?.quota?.rate_limit.reset_at).toBeGreaterThan(nowSec);
      expect(acct?.quota?.secondary_rate_limit?.used_percent).toBe(33);
      expect(acct?.quotaFetchedAt).toBeTruthy();
    });
  });

  describe("acquire skips exhausted accounts", () => {
    it("skips account marked via applyRateLimit429", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "b1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "b2" }));

      pool.applyRateLimit429(id1, { resetsAtSec: Math.floor(Date.now() / 1000) + 7200 });

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("returns null when all accounts exhausted", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "c1" }));
      pool.applyRateLimit429(id1, { resetsAtSec: Math.floor(Date.now() / 1000) + 7200 });

      const acquired = pool.acquire();
      expect(acquired).toBeNull();
    });

    it("skips active accounts with cached primary quota limit_reached", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "d1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "d2" }));
      pool.updateCachedQuota(id1, makeQuota({
        rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: Math.floor(Date.now() / 1000) + 7200,
          limit_window_seconds: 7200,
        },
      }));

      const acquired = pool.acquire({ preferredEntryId: id1 });
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("skips active accounts with cached secondary quota limit_reached", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "e1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "e2" }));
      pool.updateCachedQuota(id1, makeQuota({
        secondary_rate_limit: {
          limit_reached: true,
          used_percent: 100,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 3600,
        },
      }));

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("skips active accounts with cached code review quota limit_reached", () => {
      const id1 = pool.addAccount(createValidJwt({ accountId: "r1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "r2" }));
      pool.updateCachedQuota(id1, makeQuota({
        code_review_rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 3600,
        },
      }));

      const acquired = pool.acquire({ preferredEntryId: id1 });
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("allows account after cached secondary quota reset time has passed", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "s1" }));
      const nowSec = Math.floor(Date.now() / 1000);
      pool.updateCachedQuota(id, makeQuota({
        secondary_rate_limit: {
          limit_reached: true,
          used_percent: 100,
          reset_at: nowSec - 10,
          limit_window_seconds: 3600,
        },
      }));

      const acquired = pool.acquire({ preferredEntryId: id });
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id);
      pool.release(acquired!.entryId);

      const entry = pool.getEntry(id);
      const secondary = entry?.cachedQuota?.secondary_rate_limit;
      expect(secondary).toBeDefined();
      expect(secondary?.limit_reached).toBe(false);
      expect(secondary?.used_percent).toBe(0);
      expect(secondary?.reset_at).toBeGreaterThan(nowSec);
    });

    it("allows account after cached code review quota reset time has passed", () => {
      const id = pool.addAccount(createValidJwt({ accountId: "r3" }));
      const nowSec = Math.floor(Date.now() / 1000);
      pool.updateCachedQuota(id, makeQuota({
        code_review_rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: nowSec - 10,
          limit_window_seconds: 3600,
        },
      }));

      const acquired = pool.acquire({ preferredEntryId: id });
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id);
      pool.release(acquired!.entryId);

      const entry = pool.getEntry(id);
      const codeReview = entry?.cachedQuota?.code_review_rate_limit;
      expect(codeReview).toBeDefined();
      expect(codeReview?.limit_reached).toBe(false);
      expect(codeReview?.used_percent).toBe(0);
      expect(codeReview?.reset_at).toBeGreaterThan(nowSec);
    });

    it("allows cached exhausted accounts when skip_exhausted is false", () => {
      resetConfigForTesting();
      setConfigForTesting(createMockConfig({ quota: { skip_exhausted: false } }));
      pool = new AccountPool({ persistence: createMemoryPersistence() });
      const id = pool.addAccount(createValidJwt({ accountId: "f1" }));
      pool.updateCachedQuota(id, makeQuota({
        rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: Math.floor(Date.now() / 1000) + 7200,
          limit_window_seconds: 7200,
        },
      }));

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id);
      pool.release(acquired!.entryId);
    });
  });
});
