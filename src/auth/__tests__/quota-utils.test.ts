import { describe, it, expect } from "vitest";
import { toQuota } from "../quota-utils.js";
import type { CodexUsageResponse } from "../../proxy/codex-api.js";

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

// ── isAnyLimitReached / maxResetAt ──────────────────────────────────

import { isAnyLimitReached, maxResetAt } from "../quota-utils.js";

function makeQuota(overrides?: {
  primaryReached?: boolean;
  primaryReset?: number | null;
  secondaryReached?: boolean;
  secondaryReset?: number | null;
}) {
  const o = overrides ?? {};
  const hasSecondary = "secondaryReached" in o || "secondaryReset" in o;
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: o.primaryReached ?? false,
      used_percent: o.primaryReached ? 100 : 50,
      reset_at: "primaryReset" in o ? o.primaryReset : 1700000000,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: hasSecondary
      ? {
          limit_reached: o.secondaryReached ?? false,
          used_percent: o.secondaryReached ? 100 : 50,
          reset_at: "secondaryReset" in o ? o.secondaryReset : 1700500000,
          limit_window_seconds: 604800,
        }
      : null,
    code_review_rate_limit: null,
  } satisfies ReturnType<typeof toQuota>;
}

describe("isAnyLimitReached", () => {
  it("returns false for null/undefined quota", () => {
    expect(isAnyLimitReached(null)).toBe(false);
    expect(isAnyLimitReached(undefined)).toBe(false);
  });

  it("returns false when neither limit reached", () => {
    expect(isAnyLimitReached(makeQuota())).toBe(false);
  });

  it("returns true when only primary reached", () => {
    expect(isAnyLimitReached(makeQuota({ primaryReached: true }))).toBe(true);
  });

  it("returns true when only secondary reached", () => {
    expect(isAnyLimitReached(makeQuota({ secondaryReached: true }))).toBe(true);
  });

  it("returns true when both reached", () => {
    expect(isAnyLimitReached(makeQuota({ primaryReached: true, secondaryReached: true }))).toBe(true);
  });
});

describe("maxResetAt", () => {
  it("returns null for null/undefined quota", () => {
    expect(maxResetAt(null)).toBeNull();
    expect(maxResetAt(undefined)).toBeNull();
  });

  it("returns primary when no secondary", () => {
    expect(maxResetAt(makeQuota({ primaryReset: 1700000000 }))).toBe(1700000000);
  });

  it("returns secondary when secondary is later", () => {
    expect(maxResetAt(makeQuota({ primaryReset: 1700000000, secondaryReset: 1700500000 }))).toBe(1700500000);
  });

  it("returns primary when primary is later", () => {
    expect(maxResetAt(makeQuota({ primaryReset: 1700500000, secondaryReset: 1700000000 }))).toBe(1700500000);
  });

  it("returns null when both reset_at are null", () => {
    expect(maxResetAt(makeQuota({ primaryReset: null, secondaryReset: null }))).toBeNull();
  });
});
