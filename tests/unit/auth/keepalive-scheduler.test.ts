/**
 * Unit tests for KeepaliveScheduler.
 *
 * Covers:
 * - computeNextRun: fixed_times (today/tomorrow/cross-midnight), interval, empty, invalid
 * - executeAll: account filtering (active only), concurrency batching, error isolation
 * - Disabled scheduler: start() is a no-op
 * - getStatus: reflects enabled, mode, nextRun, lastRun, lastResults
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── File system / paths mock (prevent loading real accounts.json) ──

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-keepalive"),
  getConfigDir: vi.fn(() => "/tmp/test-keepalive/config"),
}));

// ── Config mock ───────────────────────────────────────────────────

const mockConfig = {
  account_keepalive: {
    enabled: true,
    mode: "fixed_times" as "fixed_times" | "interval",
    fixed_times: ["09:00", "18:00"],
    interval_minutes: null as number | null,
    concurrency: 2,
    per_account_delay_ms: 0,
  },
  tls: { proxy_url: null as string | null },
  auth: {
    rotation_strategy: "least_used",
    rate_limit_backoff_seconds: 60,
    max_concurrent_per_account: 3,
    request_interval_ms: 50,
    refresh_enabled: false,
    refresh_concurrency: 1,
    refresh_margin_seconds: 300,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

// ── CodexApi mock ──────────────────────────────────────────────────

const mockGetUsage = vi.fn(async () => ({
  rate_limit: {
    limit_reached: false,
    used_percent: 30,
    reset_at: Math.floor(Date.now() / 1000) + 3600,
    limit_window_seconds: 3600,
    allowed: true,
  },
  secondary_rate_limit: null,
  code_review_rate_limit: null,
}));

vi.mock("@src/proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    getUsage: mockGetUsage,
  })),
}));

vi.mock("@src/auth/quota-utils.js", () => ({
  toQuota: vi.fn((usage: unknown) => usage),
}));

// ── Imports ───────────────────────────────────────────────────────

import { computeNextRun, KeepaliveScheduler } from "@src/auth/keepalive-scheduler.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { createValidJwt } from "@helpers/jwt.js";

// ── computeNextRun ────────────────────────────────────────────────

describe("computeNextRun", () => {
  describe("fixed_times mode", () => {
    it("returns the next upcoming slot today", () => {
      const now = new Date("2024-06-15T08:00:00");
      vi.setSystemTime(now);

      const result = computeNextRun({
        enabled: true,
        mode: "fixed_times",
        fixed_times: ["09:00", "18:00"],
        interval_minutes: null,
        concurrency: 2,
        per_account_delay_ms: 0,
      });

      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(9);
      expect(result!.getMinutes()).toBe(0);
      expect(result!.getDate()).toBe(15);
    });

    it("wraps to tomorrow when all slots have passed", () => {
      const now = new Date("2024-06-15T20:00:00");
      vi.setSystemTime(now);

      const result = computeNextRun({
        enabled: true,
        mode: "fixed_times",
        fixed_times: ["09:00", "18:00"],
        interval_minutes: null,
        concurrency: 2,
        per_account_delay_ms: 0,
      });

      expect(result).not.toBeNull();
      expect(result!.getDate()).toBe(16); // tomorrow
      expect(result!.getHours()).toBe(9);
    });

    it("picks the earliest of multiple future slots", () => {
      const now = new Date("2024-06-15T10:00:00");
      vi.setSystemTime(now);

      const result = computeNextRun({
        enabled: true,
        mode: "fixed_times",
        fixed_times: ["18:00", "12:00", "14:00"],
        interval_minutes: null,
        concurrency: 2,
        per_account_delay_ms: 0,
      });

      expect(result!.getHours()).toBe(12);
    });

    it("returns null for empty fixed_times", () => {
      vi.setSystemTime(new Date("2024-06-15T10:00:00"));
      const result = computeNextRun({
        enabled: true,
        mode: "fixed_times",
        fixed_times: [],
        interval_minutes: null,
        concurrency: 2,
        per_account_delay_ms: 0,
      });
      expect(result).toBeNull();
    });
  });

  describe("interval mode", () => {
    it("returns now + interval_minutes", () => {
      const now = new Date("2024-06-15T10:00:00");
      vi.setSystemTime(now);

      const result = computeNextRun({
        enabled: true,
        mode: "interval",
        fixed_times: [],
        interval_minutes: 30,
        concurrency: 2,
        per_account_delay_ms: 0,
      });

      expect(result).not.toBeNull();
      expect(result!.getTime()).toBe(now.getTime() + 30 * 60_000);
    });

    it("returns null when interval_minutes is null", () => {
      vi.setSystemTime(new Date("2024-06-15T10:00:00"));
      const result = computeNextRun({
        enabled: true,
        mode: "interval",
        fixed_times: [],
        interval_minutes: null,
        concurrency: 2,
        per_account_delay_ms: 0,
      });
      expect(result).toBeNull();
    });
  });
});

// ── KeepaliveScheduler ────────────────────────────────────────────

function makePool(): AccountPool {
  return new AccountPool();
}

function makeJwt(accountId: string): string {
  return createValidJwt({ accountId, email: `${accountId}@test.com` });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockConfig.account_keepalive.enabled = true;
  mockConfig.account_keepalive.mode = "fixed_times";
  mockConfig.account_keepalive.fixed_times = ["09:00", "18:00"];
  mockConfig.account_keepalive.interval_minutes = null;
  mockConfig.account_keepalive.concurrency = 2;
  mockConfig.account_keepalive.per_account_delay_ms = 0;
  mockGetUsage.mockClear();
});

describe("getStatus", () => {
  it("reflects enabled and mode from config", () => {
    const pool = makePool();
    const scheduler = new KeepaliveScheduler(pool);
    const status = scheduler.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.mode).toBe("fixed_times");
    expect(status.lastRun).toBeNull();
    expect(status.lastResults).toEqual([]);
    scheduler.destroy();
    pool.destroy();
  });
});

describe("disabled scheduler", () => {
  it("start() is a no-op when enabled=false", () => {
    mockConfig.account_keepalive.enabled = false;
    const pool = makePool();
    const scheduler = new KeepaliveScheduler(pool);
    scheduler.start();
    const status = scheduler.getStatus();
    expect(status.nextRun).toBeNull();
    scheduler.destroy();
    pool.destroy();
  });
});

describe("runNow", () => {
  it("skips disabled and non-active accounts", async () => {
    const pool = makePool();
    const id1 = pool.addAccount(makeJwt("acct-keepalive-1"));
    const id2 = pool.addAccount(makeJwt("acct-keepalive-2"));
    pool.markStatus(id2, "disabled");

    const scheduler = new KeepaliveScheduler(pool);
    const results = await scheduler.runNow();

    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("ok");
    expect(results[0].entryId).toBe(id1);
    expect(mockGetUsage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
    pool.destroy();
  });

  it("returns empty results when pool has no active accounts", async () => {
    const pool = makePool();
    const scheduler = new KeepaliveScheduler(pool);
    const results = await scheduler.runNow();
    expect(results).toEqual([]);
    scheduler.destroy();
    pool.destroy();
  });

  it("one account error does not prevent others from running", async () => {
    const pool = makePool();
    const id1 = pool.addAccount(makeJwt("acct-keepalive-err1"));
    const id2 = pool.addAccount(makeJwt("acct-keepalive-err2"));

    // First call fails, second succeeds
    mockGetUsage
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({
        rate_limit: { limit_reached: false, used_percent: 20, reset_at: 0, limit_window_seconds: 3600, allowed: true },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      });

    const scheduler = new KeepaliveScheduler(pool);
    const results = await scheduler.runNow();

    expect(results).toHaveLength(2);
    const errorResult = results.find((r) => r.result === "error");
    const okResult = results.find((r) => r.result === "ok");
    expect(errorResult).toBeDefined();
    expect(okResult).toBeDefined();

    scheduler.destroy();
    pool.destroy();
    // Clean up test accounts
    pool.removeAccount(id1);
    pool.removeAccount(id2);
  });

  it("marks deactivated account as expired on error", async () => {
    const pool = makePool();
    const id = pool.addAccount(makeJwt("acct-keepalive-deact"));
    mockGetUsage.mockRejectedValueOnce(new Error("Account has been deactivated"));

    const scheduler = new KeepaliveScheduler(pool);
    const results = await scheduler.runNow();

    expect(results[0].result).toBe("error");
    expect(pool.getEntry(id)?.status).toBe("expired");

    scheduler.destroy();
    pool.destroy();
  });

  it("updates lastRun and lastResults after execution", async () => {
    const pool = makePool();
    pool.addAccount(makeJwt("acct-keepalive-last"));

    const scheduler = new KeepaliveScheduler(pool);
    expect(scheduler.getStatus().lastRun).toBeNull();

    await scheduler.runNow();

    expect(scheduler.getStatus().lastRun).not.toBeNull();
    expect(scheduler.getStatus().lastResults).toHaveLength(1);

    scheduler.destroy();
    pool.destroy();
  });

  it("concurrent runNow calls do not double-execute", async () => {
    vi.useRealTimers();
    const pool = makePool();
    pool.addAccount(makeJwt("acct-keepalive-concurrent"));

    // Make getUsage take a tick so both calls overlap
    mockGetUsage.mockImplementation(async () => {
      await new Promise((r) => setImmediate(r));
      return {
        rate_limit: { limit_reached: false, used_percent: 10, reset_at: 0, limit_window_seconds: 3600, allowed: true },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      };
    });

    const scheduler = new KeepaliveScheduler(pool);
    const [r1, r2] = await Promise.all([scheduler.runNow(), scheduler.runNow()]);

    // One of them should have been skipped (running guard), total work = 1
    const totalCalls = r1.length + r2.length;
    expect(totalCalls).toBe(1);

    scheduler.destroy();
    pool.destroy();
    vi.useFakeTimers();
  });
});
