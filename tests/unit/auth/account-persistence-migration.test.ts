/**
 * Tests for the legacy rate_limit_until → cachedQuota migration applied
 * during AccountPersistence.load().
 *
 * The proxy previously kept a local lock in `entry.usage.rate_limit_until`
 * plus `entry.status === "rate_limited"`. We are retiring both in favour of
 * `cachedQuota.rate_limit.limit_reached/reset_at` as the single source of
 * truth. On load, legacy entries must be coerced so existing deployments
 * survive a restart.
 */

import { describe, it, expect } from "vitest";
import type { AccountEntry } from "@src/auth/types.js";
import { migrateLegacyRateLimit } from "@src/auth/account-persistence.js";

function makeEntry(overrides?: Partial<AccountEntry>): AccountEntry {
  return {
    id: "e1",
    token: "tok",
    refreshToken: null,
    email: null,
    accountId: null,
    userId: null,
    label: null,
    planType: "plus",
    proxyApiKey: "pk",
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
    ...overrides,
  };
}

describe("migrateLegacyRateLimit", () => {
  it("legacy status=rate_limited + future rate_limit_until → status=active + synthesized cachedQuota.rate_limit", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString(); // +1 h
    const futureSec = Math.floor(new Date(future).getTime() / 1000);
    const entry = makeEntry({ status: "rate_limited", usage: { ...makeEntry().usage, rate_limit_until: future } });

    const changed = migrateLegacyRateLimit(entry);

    expect(changed).toBe(true);
    expect(entry.status).toBe("active");
    expect(entry.usage.rate_limit_until).toBeNull();
    expect(entry.cachedQuota?.rate_limit.limit_reached).toBe(true);
    expect(entry.cachedQuota?.rate_limit.reset_at).toBe(futureSec);
  });

  it("synthesizes cachedQuota when missing", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const entry = makeEntry({
      status: "rate_limited",
      usage: { ...makeEntry().usage, rate_limit_until: future },
      cachedQuota: null,
    });

    migrateLegacyRateLimit(entry);

    expect(entry.cachedQuota).not.toBeNull();
    expect(entry.cachedQuota?.plan_type).toBe("plus");
  });

  it("trusts fresh cachedQuota (fetched after rate_limit_until was set) — drops local lock, leaves cachedQuota alone", () => {
    const oldUntil = new Date(Date.now() - 1_000).toISOString(); // already past
    const freshFetchedAt = new Date(Date.now() - 500).toISOString();
    const entry = makeEntry({
      status: "rate_limited",
      usage: { ...makeEntry().usage, rate_limit_until: oldUntil },
      cachedQuota: {
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          used_percent: 0,
          reset_at: Math.floor(Date.now() / 1000) + 18000,
          limit_window_seconds: 18000,
        },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      },
      quotaFetchedAt: freshFetchedAt,
    });

    migrateLegacyRateLimit(entry);

    expect(entry.status).toBe("active");
    expect(entry.usage.rate_limit_until).toBeNull();
    expect(entry.cachedQuota?.rate_limit.limit_reached).toBe(false); // not overwritten
  });

  it("overwrites stale cachedQuota when rate_limit_until is newer than quotaFetchedAt", () => {
    const recentUntil = new Date(Date.now() + 3_600_000).toISOString();
    const oldFetchedAt = new Date(Date.now() - 10_000_000).toISOString();
    const entry = makeEntry({
      status: "rate_limited",
      usage: { ...makeEntry().usage, rate_limit_until: recentUntil },
      cachedQuota: {
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          used_percent: 0,
          reset_at: Math.floor(Date.now() / 1000) + 100,
          limit_window_seconds: 18000,
        },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      },
      quotaFetchedAt: oldFetchedAt,
    });

    migrateLegacyRateLimit(entry);

    expect(entry.cachedQuota?.rate_limit.limit_reached).toBe(true);
    expect(entry.cachedQuota?.rate_limit.reset_at).toBe(Math.floor(new Date(recentUntil).getTime() / 1000));
  });

  it("status=active with orphan rate_limit_until in past → just clears the field", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry = makeEntry({
      status: "active",
      usage: { ...makeEntry().usage, rate_limit_until: past },
    });

    const changed = migrateLegacyRateLimit(entry);

    expect(changed).toBe(true);
    expect(entry.status).toBe("active");
    expect(entry.usage.rate_limit_until).toBeNull();
    expect(entry.cachedQuota).toBeNull(); // didn't synth, lock was already irrelevant
  });

  it("entry without legacy fields is a no-op", () => {
    const entry = makeEntry({ status: "active" });

    const changed = migrateLegacyRateLimit(entry);

    expect(changed).toBe(false);
    expect(entry.status).toBe("active");
    expect(entry.usage.rate_limit_until).toBeNull();
  });

  it("status=rate_limited with no rate_limit_until just coerces status", () => {
    const entry = makeEntry({ status: "rate_limited" });

    migrateLegacyRateLimit(entry);

    expect(entry.status).toBe("active");
    expect(entry.cachedQuota).toBeNull();
  });
});
