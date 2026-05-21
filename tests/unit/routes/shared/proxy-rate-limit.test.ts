import { describe, expect, it, vi } from "vitest";
import {
  applyRateLimitHeaders,
  applyParsedRateLimits,
  type RateLimitAccountPool,
} from "@src/routes/shared/proxy-rate-limit.js";
import type { ParsedRateLimit } from "@src/proxy/rate-limit-headers.js";

function createPool(planType: string | null | "missing" = "team"): {
  pool: RateLimitAccountPool;
  getEntry: ReturnType<typeof vi.fn>;
  updateCachedQuota: ReturnType<typeof vi.fn>;
  syncRateLimitWindow: ReturnType<typeof vi.fn>;
  applyRateLimit429: ReturnType<typeof vi.fn>;
} {
  const getEntry = vi.fn(() => planType === "missing" ? undefined : { planType });
  const updateCachedQuota = vi.fn();
  const syncRateLimitWindow = vi.fn();
  const applyRateLimit429 = vi.fn();
  return {
    pool: {
      getEntry,
      updateCachedQuota,
      syncRateLimitWindow,
      applyRateLimit429,
    },
    getEntry,
    updateCachedQuota,
    syncRateLimitWindow,
    applyRateLimit429,
  };
}

describe("applyParsedRateLimits", () => {
  it("updates cached quota from parsed rate limits and syncs the primary window", () => {
    const { pool, updateCachedQuota, syncRateLimitWindow, applyRateLimit429 } = createPool("team");
    const rateLimits: ParsedRateLimit = {
      primary: { used_percent: 42, window_minutes: 300, reset_at: 1_700_000_000 },
      secondary: { used_percent: 18, window_minutes: 10_080, reset_at: 1_700_500_000 },
      code_review: null,
    };

    applyParsedRateLimits({ accountPool: pool, entryId: "entry-1", rateLimits, nowSec: 1_699_999_900 });

    expect(updateCachedQuota).toHaveBeenCalledWith("entry-1", {
      plan_type: "team",
      rate_limit: {
        used_percent: 42,
        remaining_percent: 58,
        reset_at: 1_700_000_000,
        limit_window_seconds: 18_000,
        allowed: true,
        limit_reached: false,
      },
      secondary_rate_limit: {
        used_percent: 18,
        remaining_percent: 82,
        reset_at: 1_700_500_000,
        limit_window_seconds: 604_800,
        limit_reached: false,
      },
      code_review_rate_limit: null,
    });
    expect(syncRateLimitWindow).toHaveBeenCalledWith("entry-1", 1_700_000_000, 18_000);
    expect(applyRateLimit429).not.toHaveBeenCalled();
  });

  it("proactively applies a 429 reset when primary quota is exhausted in the future", () => {
    const { pool, applyRateLimit429 } = createPool();
    const rateLimits: ParsedRateLimit = {
      primary: { used_percent: 100, window_minutes: 60, reset_at: 1_700_000_300 },
      secondary: null,
      code_review: null,
    };

    applyParsedRateLimits({ accountPool: pool, entryId: "entry-1", rateLimits, nowSec: 1_700_000_000 });

    expect(applyRateLimit429).toHaveBeenCalledWith("entry-1", { resetsAtSec: 1_700_000_300 });
  });

  it("does not apply a 429 reset when the exhausted primary reset is not in the future", () => {
    const { pool, applyRateLimit429 } = createPool();
    const rateLimits: ParsedRateLimit = {
      primary: { used_percent: 100, window_minutes: 60, reset_at: 1_700_000_000 },
      secondary: null,
      code_review: null,
    };

    applyParsedRateLimits({ accountPool: pool, entryId: "entry-1", rateLimits, nowSec: 1_700_000_001 });

    expect(applyRateLimit429).not.toHaveBeenCalled();
  });

  it("does not sync a primary window when the primary reset is absent", () => {
    const { pool, syncRateLimitWindow, applyRateLimit429 } = createPool(null);
    const rateLimits: ParsedRateLimit = {
      primary: null,
      secondary: { used_percent: 100, window_minutes: 10_080, reset_at: 1_700_500_000 },
      code_review: null,
    };

    applyParsedRateLimits({ accountPool: pool, entryId: "entry-1", rateLimits, nowSec: 1_700_000_000 });

    expect(syncRateLimitWindow).not.toHaveBeenCalled();
    expect(applyRateLimit429).not.toHaveBeenCalled();
  });

  it("uses unknown plan when the entry is missing", () => {
    const { pool, updateCachedQuota } = createPool("missing");
    const rateLimits: ParsedRateLimit = {
      primary: { used_percent: 5, window_minutes: null, reset_at: null },
      secondary: null,
      code_review: null,
    };

    applyParsedRateLimits({ accountPool: pool, entryId: "missing-entry", rateLimits });

    expect(updateCachedQuota).toHaveBeenCalledWith("missing-entry", expect.objectContaining({
      plan_type: "unknown",
    }));
  });

  it("parses response headers before applying rate-limit updates", () => {
    const { pool, updateCachedQuota, syncRateLimitWindow } = createPool("plus");
    const headers = new Headers({
      "x-codex-primary-used-percent": "99",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1700000300",
    });

    const applied = applyRateLimitHeaders({
      accountPool: pool,
      entryId: "entry-headers",
      headers,
      nowSec: 1_700_000_000,
    });

    expect(applied).toBe(true);
    expect(updateCachedQuota).toHaveBeenCalledWith("entry-headers", expect.objectContaining({
      plan_type: "plus",
      rate_limit: expect.objectContaining({
        used_percent: 99,
        reset_at: 1_700_000_300,
        limit_window_seconds: 18_000,
        limit_reached: false,
      }),
    }));
    expect(syncRateLimitWindow).toHaveBeenCalledWith("entry-headers", 1_700_000_300, 18_000);
  });
});
