import { describe, it, expect } from "vitest";
import { isQuotaExhausted, hasReachedCachedQuota } from "@src/auth/quota-skip.js";
import type { AccountEntry, CodexQuota } from "@src/auth/types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 10,
      reset_at: 1700000000,
      limit_window_seconds: 3600,
      remaining_percent: 90,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    rate_limits_by_limit_id: null,
    ...overrides,
  };
}

function makeEntry(quota: CodexQuota | null): AccountEntry {
  return {
    id: "acc-1",
    token: "fake-jwt",
    accountId: "org-1",
    status: "active",
    addedAt: new Date().toISOString(),
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      estimated_cost_usd: 0,
      empty_response_count: 0,
      last_used: null,
      window_reset_at: null,
    },
    cachedQuota: quota,
    quotaFetchedAt: new Date().toISOString(),
  };
}

describe("isQuotaExhausted", () => {
  it("returns false for null/undefined quota", () => {
    expect(isQuotaExhausted(null)).toBe(false);
    expect(isQuotaExhausted(undefined)).toBe(false);
  });

  it("returns true when primary rate limit is reached", () => {
    const quota = makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: 1700000000,
        limit_window_seconds: 3600,
      },
    });
    expect(isQuotaExhausted(quota)).toBe(true);
    expect(isQuotaExhausted(quota, "gpt-5.3-codex")).toBe(true);
    expect(isQuotaExhausted(quota, "gpt-5.3-codex-spark")).toBe(true);
  });

  it("returns true when secondary rate limit is reached", () => {
    const quota = makeQuota({
      secondary_rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: 1700000000,
        limit_window_seconds: 604800,
      },
    });
    expect(isQuotaExhausted(quota)).toBe(true);
  });

  it("returns true when code review rate limit is reached", () => {
    const quota = makeQuota({
      code_review_rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: 1700000000,
        limit_window_seconds: 3600,
      },
    });
    expect(isQuotaExhausted(quota)).toBe(true);
  });

  it("returns false for non-spark model when only spark rate limit is reached", () => {
    const quota = makeQuota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          remaining_percent: 0,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
        },
      },
    });
    expect(isQuotaExhausted(quota)).toBe(false);
    expect(isQuotaExhausted(quota, "gpt-5.3-codex")).toBe(false);
    expect(isQuotaExhausted(quota, "gpt-5.4")).toBe(false);
    expect(isQuotaExhausted(quota, undefined)).toBe(false);
  });

  it("returns true for spark model when spark rate limit is reached", () => {
    const quota = makeQuota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          remaining_percent: 0,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
        },
      },
    });
    expect(isQuotaExhausted(quota, "gpt-5.3-codex-spark")).toBe(true);
    expect(isQuotaExhausted(quota, "gpt-5.3-spark")).toBe(true);
  });
});

describe("hasReachedCachedQuota", () => {
  it("evaluates entry cachedQuota with optional model", () => {
    const quota = makeQuota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          remaining_percent: 0,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
        },
      },
    });
    const entry = makeEntry(quota);

    expect(hasReachedCachedQuota(entry)).toBe(false);
    expect(hasReachedCachedQuota(entry, "gpt-5.3-codex")).toBe(false);
    expect(hasReachedCachedQuota(entry, "gpt-5.3-codex-spark")).toBe(true);
  });
});
