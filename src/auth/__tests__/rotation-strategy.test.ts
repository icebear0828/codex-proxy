import { describe, it, expect } from "vitest";
import { getRotationStrategy } from "../rotation-strategy.js";
import type { RotationState } from "../rotation-strategy.js";
import type { AccountEntry } from "../types.js";

function makeEntry(id: string, overrides?: Partial<AccountEntry["usage"]>): AccountEntry {
  return {
    id,
    token: `tok-${id}`,
    refreshToken: null,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
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
    cachedQuota: null,
    quotaFetchedAt: null,
  };
}

describe("rotation-strategy", () => {
  describe("least_used", () => {
    const strategy = getRotationStrategy("least_used");
    const state: RotationState = { roundRobinIndex: 0 };

    it("selects account with fewest requests", () => {
      const a = makeEntry("a", { request_count: 5 });
      const b = makeEntry("b", { request_count: 2 });
      const c = makeEntry("c", { request_count: 8 });
      expect(strategy.select([a, b, c], state).id).toBe("b");
    });

    it("breaks ties by window_reset_at (sooner wins)", () => {
      const a = makeEntry("a", { request_count: 3, window_reset_at: 2000 });
      const b = makeEntry("b", { request_count: 3, window_reset_at: 1000 });
      expect(strategy.select([a, b], state).id).toBe("b");
    });

    it("breaks further ties by last_used (LRU)", () => {
      const a = makeEntry("a", { request_count: 3, last_used: "2026-01-02T00:00:00Z" });
      const b = makeEntry("b", { request_count: 3, last_used: "2026-01-01T00:00:00Z" });
      expect(strategy.select([a, b], state).id).toBe("b");
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
