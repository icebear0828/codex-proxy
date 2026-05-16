// Pure-logic tests for the PoolOverview aggregation function.
//
// Imports the component module by string path because vitest's include
// pattern currently doesn't cover web .tsx files (jsdom devDep missing).
// Once the renderer environment is set up in a follow-up PR, a renderer
// test can live next to the component instead.
import { describe, it, expect } from "vitest";
import { computePoolStats } from "../../../web/src/components/PoolOverview";
import type { Account } from "../../../shared/types";

function plus(overrides: Partial<Account> = {}): Account {
  return {
    id: "p" + (overrides.id ?? Math.random().toString(36).slice(2, 6)),
    email: overrides.email ?? "p@example.com",
    status: "active",
    planType: "plus",
    ...overrides,
  } as Account;
}

function pro(balance: number, overrides: Partial<Account> = {}): Account {
  return {
    id: "pro-" + (overrides.id ?? Math.random().toString(36).slice(2, 6)),
    email: overrides.email ?? "pro@example.com",
    status: "active",
    planType: "pro",
    quota: {
      credits: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance,
      },
    },
    ...overrides,
  } as Account;
}

describe("computePoolStats", () => {
  it("returns zero counts and no top-usage for an empty pool", () => {
    const stats = computePoolStats([]);
    expect(stats.active).toBe(0);
    expect(stats.exhausted).toBe(0);
    expect(stats.totalCredits).toBe(0);
    expect(stats.totalUsd).toBeNull();
    expect(stats.hasAnyCredits).toBe(false);
    expect(stats.topUsage).toBeNull();
  });

  it("counts active vs quota-exhausted via derivedStatus", () => {
    const stats = computePoolStats([
      plus({ id: "a", status: "active" }),
      plus({
        id: "b",
        status: "active",
        quota: {
          secondary_rate_limit: {
            used_percent: 100,
            limit_reached: true,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      }),
      plus({ id: "c", status: "disabled" }),
    ]);
    expect(stats.active).toBe(1);
    expect(stats.exhausted).toBe(1);
  });

  it("sums credit balance across accounts with has_credits=true (skips Plus)", () => {
    const stats = computePoolStats([
      plus(),                  // Plus — ignored
      pro(247.5, { id: "p1" }),
      pro(100, { id: "p2" }),
    ]);
    expect(stats.hasAnyCredits).toBe(true);
    expect(stats.totalCredits).toBe(347.5);
    // 347.5 credits / 25 USD = $13.9
    expect(stats.totalUsd).toBeCloseTo(13.9);
  });

  it("treats unlimited accounts as 'has credits' but excludes their balance from the sum", () => {
    const stats = computePoolStats([
      pro(50, { id: "p1" }),
      pro(0, {
        id: "p2",
        quota: {
          credits: { has_credits: true, unlimited: true, overage_limit_reached: false, balance: 999 },
        },
      }),
    ]);
    expect(stats.hasAnyCredits).toBe(true);
    expect(stats.totalCredits).toBe(50);
  });

  it("hasAnyCredits stays false when only Plus accounts (has_credits=false) are present", () => {
    const stats = computePoolStats([plus({ id: "a" }), plus({ id: "b" })]);
    expect(stats.hasAnyCredits).toBe(false);
    expect(stats.totalUsd).toBeNull();
  });

  it("picks the account with highest secondary used_percent for topUsage", () => {
    const accounts = [
      plus({
        id: "low",
        email: "low@x.com",
        quota: { secondary_rate_limit: { used_percent: 30, limit_reached: false, reset_at: 1700000000 } },
      }),
      plus({
        id: "high",
        email: "high@x.com",
        quota: { secondary_rate_limit: { used_percent: 92, limit_reached: false, reset_at: 1700050000 } },
      }),
      plus({
        id: "mid",
        email: "mid@x.com",
        quota: { secondary_rate_limit: { used_percent: 65, limit_reached: false, reset_at: 1700020000 } },
      }),
    ];
    const stats = computePoolStats(accounts);
    expect(stats.topUsage).not.toBeNull();
    expect(stats.topUsage!.account.email).toBe("high@x.com");
    expect(stats.topUsage!.pct).toBe(92);
    expect(stats.topUsage!.resetAt).toBe(1700050000);
  });

  it("treats limit_reached as 100% for topUsage even when used_percent is null", () => {
    const stats = computePoolStats([
      plus({
        id: "capped",
        email: "capped@x.com",
        quota: { secondary_rate_limit: { limit_reached: true, used_percent: null, reset_at: 1700000000 } },
      }),
    ]);
    expect(stats.topUsage?.pct).toBe(100);
  });
});
