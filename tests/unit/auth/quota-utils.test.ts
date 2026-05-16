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
    expect(quota.code_review_rate_limit!.limit_window_seconds).toBe(3600);
  });

  it("maps WHAM additional_rate_limits into named buckets and review quota", () => {
    const quota = toQuota(makeUsageResponse({
      additional_rate_limits: [
        {
          limit_name: "Codex Other",
          metered_feature: "codex_other",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 12,
              reset_at: 1700002000,
              limit_window_seconds: 1800,
              reset_after_seconds: 600,
            },
            secondary_window: {
              used_percent: 34,
              reset_at: 1700100000,
              limit_window_seconds: 604800,
              reset_after_seconds: 9800,
            },
          },
        },
        {
          limit_name: "Codex Code Review",
          metered_feature: "codex_code_review",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 7,
              reset_at: 1700003000,
              limit_window_seconds: 1800,
              reset_after_seconds: 500,
            },
            secondary_window: null,
          },
        },
      ],
    }));

    expect(quota.rate_limits_by_limit_id?.codex_other).toMatchObject({
      limit_id: "codex_other",
      limit_name: "Codex Other",
      used_percent: 12,
      limit_window_seconds: 1800,
      secondary_rate_limit: {
        used_percent: 34,
        reset_at: 1700100000,
        limit_window_seconds: 604800,
      },
    });
    expect(quota.code_review_rate_limit).toMatchObject({
      allowed: true,
      limit_reached: false,
      used_percent: 7,
      reset_at: 1700003000,
      limit_window_seconds: 1800,
    });
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

  describe("credits", () => {
    it("carries credits block through when present (Plus shape: has_credits=false, balance=0)", () => {
      const quota = toQuota(makeUsageResponse({
        credits: {
          has_credits: false,
          unlimited: false,
          overage_limit_reached: false,
          balance: "0",
        },
      }));
      expect(quota.credits).toEqual({
        has_credits: false,
        unlimited: false,
        overage_limit_reached: false,
        balance: 0,
      });
    });

    it("parses decimal-string balance into number for Pro / PAYG accounts", () => {
      const quota = toQuota(makeUsageResponse({
        credits: {
          has_credits: true,
          unlimited: false,
          overage_limit_reached: false,
          balance: "247.50",
        },
      }));
      expect(quota.credits?.has_credits).toBe(true);
      expect(quota.credits?.balance).toBe(247.5);
    });

    it("emits null credits when upstream omits the block", () => {
      const quota = toQuota(makeUsageResponse({ credits: null }));
      expect(quota.credits).toBeNull();
    });

    it("emits null credits when upstream sends a malformed block (defensive)", () => {
      const quota = toQuota(makeUsageResponse({
        // Simulate a future upstream schema where balance is missing entirely
        credits: { has_credits: true } as unknown as NonNullable<CodexUsageResponse["credits"]>,
      }));
      expect(quota.credits).toBeNull();
    });

    it("passes unlimited and overage_limit_reached flags through", () => {
      const quota = toQuota(makeUsageResponse({
        credits: {
          has_credits: true,
          unlimited: true,
          overage_limit_reached: true,
          balance: "0",
        },
      }));
      expect(quota.credits?.unlimited).toBe(true);
      expect(quota.credits?.overage_limit_reached).toBe(true);
    });
  });
});
