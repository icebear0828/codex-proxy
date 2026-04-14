import { describe, it, expect } from "vitest";
import { toQuota } from "@src/auth/quota-utils.js";
import type { CodexUsageResponse } from "@src/proxy/codex-api.js";

function makeUsageResponse(overrides?: Partial<CodexUsageResponse>): CodexUsageResponse {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        reset_at: 1700000000,
        limit_window_seconds: 3600,
        reset_after_seconds: 1800,
      },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    credits: null,
    promo: null,
    ...overrides,
  };
}

describe("toQuota", () => {
  it("converts primary window correctly", () => {
    const quota = toQuota(makeUsageResponse());
    expect(quota.plan_type).toBe("plus");
    expect(quota.rate_limit.used_percent).toBe(42);
    expect(quota.rate_limit.reset_at).toBe(1700000000);
    expect(quota.rate_limit.limit_window_seconds).toBe(3600);
    expect(quota.rate_limit.limit_reached).toBe(false);
    expect(quota.rate_limit.allowed).toBe(true);
    expect(quota.secondary_rate_limit).toBeNull();
    expect(quota.code_review_rate_limit).toBeNull();
  });

  it("converts secondary window when present", () => {
    const quota = toQuota(makeUsageResponse({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 10,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
          reset_after_seconds: 3000,
        },
        secondary_window: {
          used_percent: 75,
          reset_at: 1700500000,
          limit_window_seconds: 604800,
          reset_after_seconds: 300000,
        },
      },
    }));

    expect(quota.secondary_rate_limit).not.toBeNull();
    expect(quota.secondary_rate_limit!.used_percent).toBe(75);
    expect(quota.secondary_rate_limit!.reset_at).toBe(1700500000);
    expect(quota.secondary_rate_limit!.limit_window_seconds).toBe(604800);
  });

  it("converts code review rate limit when present", () => {
    const quota = toQuota(makeUsageResponse({
      code_review_rate_limit: {
        allowed: true,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          reset_at: 1700001000,
          limit_window_seconds: 3600,
          reset_after_seconds: 0,
        },
        secondary_window: null,
      },
    }));

    expect(quota.code_review_rate_limit).not.toBeNull();
    expect(quota.code_review_rate_limit!.allowed).toBe(true);
    expect(quota.code_review_rate_limit!.limit_reached).toBe(true);
    expect(quota.code_review_rate_limit!.used_percent).toBe(100);
  });

  it("secondary limit_reached inferred from own used_percent >= 100", () => {
    const quota = toQuota(makeUsageResponse({
      rate_limit: {
        allowed: true,
        limit_reached: false,       // primary NOT reached
        primary_window: {
          used_percent: 10,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
          reset_after_seconds: 3000,
        },
        secondary_window: {
          used_percent: 100,         // secondary exhausted
          reset_at: 1700500000,
          limit_window_seconds: 604800,
          reset_after_seconds: 300000,
        },
      },
    }));

    expect(quota.secondary_rate_limit!.limit_reached).toBe(true);
  });

  it("secondary limit_reached falls back to primary when own used_percent is null", () => {
    const quota = toQuota(makeUsageResponse({
      rate_limit: {
        allowed: true,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
          reset_after_seconds: 0,
        },
        secondary_window: {
          used_percent: null as unknown as number,
          reset_at: 1700500000,
          limit_window_seconds: 604800,
          reset_after_seconds: 300000,
        },
      },
    }));

    expect(quota.secondary_rate_limit!.limit_reached).toBe(true);
  });

  it("secondary limit_reached is false when own used_percent < 100", () => {
    const quota = toQuota(makeUsageResponse({
      rate_limit: {
        allowed: true,
        limit_reached: true,       // primary reached but secondary is fine
        primary_window: {
          used_percent: 100,
          reset_at: 1700000000,
          limit_window_seconds: 3600,
          reset_after_seconds: 0,
        },
        secondary_window: {
          used_percent: 50,
          reset_at: 1700500000,
          limit_window_seconds: 604800,
          reset_after_seconds: 300000,
        },
      },
    }));

    expect(quota.secondary_rate_limit!.limit_reached).toBe(false);
  });

  it("handles null primary window gracefully", () => {
    const quota = toQuota(makeUsageResponse({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: null,
        secondary_window: null,
      },
    }));

    expect(quota.rate_limit.used_percent).toBeNull();
    expect(quota.rate_limit.reset_at).toBeNull();
    expect(quota.rate_limit.limit_window_seconds).toBeNull();
  });
});
