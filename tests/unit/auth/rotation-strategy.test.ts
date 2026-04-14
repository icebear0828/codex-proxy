import { describe, it, expect } from "vitest";
import { getRotationStrategy } from "@src/auth/rotation-strategy.js";
import type { RotationState } from "@src/auth/rotation-strategy.js";
import type { AccountEntry } from "@src/auth/types.js";

import type { CodexQuota } from "@src/auth/types.js";

function makeEntry(
  id: string,
  overrides?: Partial<AccountEntry["usage"]>,
  quota?: Partial<CodexQuota> | null,
): AccountEntry {
  return {
    id,
    token: `tok-${id}`,
    refreshToken: null,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    label: null,
    planType: "free",
    proxyApiKey: `key-${id}`,
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_counters_reset_at: null,
      limit_window_seconds: null,
      ...overrides,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: quota ? {
      plan_type: "free",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: null,
        reset_at: null,
        limit_window_seconds: null,
        ...quota.rate_limit,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
      ...quota,
    } as CodexQuota : null,
    quotaFetchedAt: null,
  };
}

describe("rotation-strategy", () => {
  describe("least_used", () => {
    const strategy = getRotationStrategy("least_used");
    const state: RotationState = { roundRobinIndex: 0 };

    it("prefers account with earliest window_reset_at (use-before-refresh)", () => {
      // B resets in 1 day, A resets in 7 days — should pick B even though A has fewer requests
      const a = makeEntry("a", { request_count: 2, window_reset_at: Date.now() + 7 * 86400_000 });
      const b = makeEntry("b", { request_count: 8, window_reset_at: Date.now() + 1 * 86400_000 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("does not penalize new accounts without window_reset_at — falls through to request_count", () => {
      // Account A is brand-new (no window info yet), account B has a known window.
      // A has fewer requests so it should win: null window must not count as Infinity.
      const a = makeEntry("a", { request_count: 1 }); // no window info
      const b = makeEntry("b", { request_count: 5, window_reset_at: Date.now() + 86400_000 });
      expect(strategy.select([a, b], state).id).toBe("a");
    });

    it("falls through to request_count when both accounts have no window_reset_at", () => {
      const a = makeEntry("a", { request_count: 3 });
      const b = makeEntry("b", { request_count: 1 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("breaks reset ties by request_count (fewer wins)", () => {
      const reset = Date.now() + 86400_000;
      const a = makeEntry("a", { request_count: 5, window_reset_at: reset });
      const b = makeEntry("b", { request_count: 2, window_reset_at: reset });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("breaks further ties by last_used (LRU)", () => {
      const reset = Date.now() + 86400_000;
      const a = makeEntry("a", { request_count: 3, window_reset_at: reset, last_used: "2026-01-02T00:00:00Z" });
      const b = makeEntry("b", { request_count: 3, window_reset_at: reset, last_used: "2026-01-01T00:00:00Z" });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("deprioritizes exhausted accounts (limit_reached) even with earlier reset", () => {
      const exhausted = makeEntry(
        "exhausted",
        { request_count: 0, window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      const healthy = makeEntry(
        "healthy",
        { request_count: 5, window_reset_at: Date.now() + 7 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: false, used_percent: 30, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([exhausted, healthy], state).id).toBe("healthy");
    });

    it("sorts exhausted accounts among themselves by reset time", () => {
      const a = makeEntry(
        "a",
        { window_reset_at: Date.now() + 3 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      const b = makeEntry(
        "b",
        { window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("disperses across tied candidates on cold start (thundering herd)", () => {
      const freshState: RotationState = { roundRobinIndex: 0 };
      const candidates = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
      const picks = Array.from({ length: 6 }, () =>
        strategy.select(candidates, freshState).id,
      );
      expect(picks).toEqual(["a", "b", "c", "a", "b", "c"]);
    });

    it("treats accounts without cached quota as non-exhausted", () => {
      const noQuota = makeEntry("noQuota", { request_count: 2, window_reset_at: Date.now() + 7 * 86400_000 });
      const exhausted = makeEntry(
        "exhausted",
        { request_count: 0, window_reset_at: Date.now() + 1 * 86400_000 },
        { rate_limit: { allowed: true, limit_reached: true, used_percent: 100, reset_at: null, limit_window_seconds: null } },
      );
      expect(strategy.select([exhausted, noQuota], state).id).toBe("noQuota");
    });
  });

  describe("round_robin", () => {
    const strategy = getRotationStrategy("round_robin");

    it("cycles through candidates in order", () => {
      const state: RotationState = { roundRobinIndex: 0 };
      const a = makeEntry("a");
      const b = makeEntry("b");
      const c = makeEntry("c");
      const candidates = [a, b, c];

      expect(strategy.select(candidates, state).id).toBe("a");
      expect(strategy.select(candidates, state).id).toBe("b");
      expect(strategy.select(candidates, state).id).toBe("c");
      expect(strategy.select(candidates, state).id).toBe("a"); // wraps
    });

    it("wraps index when candidates shrink", () => {
      const state: RotationState = { roundRobinIndex: 5 };
      const a = makeEntry("a");
      const b = makeEntry("b");
      // 5 % 2 = 1 → picks b
      expect(strategy.select([a, b], state).id).toBe("b");
    });
  });

  describe("sticky", () => {
    const strategy = getRotationStrategy("sticky");
    const state: RotationState = { roundRobinIndex: 0 };

    it("selects most recently used account", () => {
      const a = makeEntry("a", { last_used: "2026-01-01T00:00:00Z" });
      const b = makeEntry("b", { last_used: "2026-01-03T00:00:00Z" });
      const c = makeEntry("c", { last_used: "2026-01-02T00:00:00Z" });
      expect(strategy.select([a, b, c], state).id).toBe("b");
    });

    it("selects any when none have been used", () => {
      const a = makeEntry("a");
      const b = makeEntry("b");
      // Both have last_used=null → both map to 0 → stable sort keeps first
      const result = strategy.select([a, b], state);
      expect(["a", "b"]).toContain(result.id);
    });
  });

  it("getRotationStrategy returns distinct strategy objects per name", () => {
    const lu = getRotationStrategy("least_used");
    const rr = getRotationStrategy("round_robin");
    const st = getRotationStrategy("sticky");
    expect(lu).not.toBe(rr);
    expect(rr).not.toBe(st);
  });

  it("select does not mutate the input candidates array", () => {
    const strategy = getRotationStrategy("least_used");
    const state: RotationState = { roundRobinIndex: 0 };
    const a = makeEntry("a", { request_count: 5 });
    const b = makeEntry("b", { request_count: 2 });
    const c = makeEntry("c", { request_count: 8 });
    const candidates = [a, b, c];
    strategy.select(candidates, state);
    // Original order preserved
    expect(candidates.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});
