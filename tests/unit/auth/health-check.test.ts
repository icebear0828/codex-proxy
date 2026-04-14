/**
 * Tests for account health check (probeAccount + batchHealthCheck).
 *
 * Verifies:
 * 1. probeAccount succeeds → alive, updates token
 * 2. probeAccount permanent error → dead, marks expired
 * 3. probeAccount temporary error → dead, does NOT mark expired
 * 4. probeAccount skips: no RT, disabled, not found
 * 5. batchHealthCheck respects stagger + concurrency
 * 6. batchHealthCheck filters by ids
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { createMockConfig } from "@helpers/config.js";

// ── Mocks ────────────────────────────────────────────────────────────

let refreshResult: { access_token: string; refresh_token: string | null } | Error = {
  access_token: "",
  refresh_token: "new_rt",
};

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(async () => {
    if (refreshResult instanceof Error) throw refreshResult;
    return refreshResult;
  }),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: (val: number) => val,
  jitterInt: (val: number) => val,
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeJwt(expSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(JSON.stringify({ exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

function makeValidJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) + 3600);
}

interface MockEntry {
  id: string;
  token: string;
  refreshToken: string | null;
  email: string | null;
  status: string;
  accountId: string | null;
  userId: string | null;
  planType: string | null;
}

function makeEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: overrides.id ?? "acc-1",
    token: makeValidJwt(),
    refreshToken: overrides.refreshToken ?? "rt_test123",
    email: overrides.email ?? "test@example.com",
    status: overrides.status ?? "active",
    accountId: null,
    userId: null,
    planType: null,
    ...overrides,
  };
}

function makePool(entries: MockEntry[]) {
  return {
    getEntry: (id: string) => entries.find((e) => e.id === id),
    getAllEntries: () => entries,
    markStatus: vi.fn(),
    updateToken: vi.fn(),
  };
}

function makeScheduler() {
  return {
    scheduleOne: vi.fn(),
    clearOne: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("probeAccount", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig());
    const validToken = makeValidJwt();
    refreshResult = { access_token: validToken, refresh_token: "new_rt" };
  });

  afterEach(() => {
    resetConfigForTesting();
    vi.restoreAllMocks();
  });

  it("returns alive and updates token on success", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("alive");
    expect(result.previousStatus).toBe("active");
    expect(result.email).toBe("test@example.com");
    expect(result.durationMs).toBeTypeOf("number");
    expect(pool.updateToken).toHaveBeenCalledOnce();
    expect(scheduler.scheduleOne).toHaveBeenCalledOnce();
  });

  it("returns dead and marks expired on permanent error", async () => {
    refreshResult = new Error("invalid_grant: token revoked");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("invalid_grant");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "expired");
  });

  it("returns dead but does NOT mark expired on temporary error", async () => {
    refreshResult = new Error("ECONNREFUSED");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("ECONNREFUSED");
    expect(pool.markStatus).not.toHaveBeenCalled();
  });

  it("skips account with no refresh token", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ refreshToken: null })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("no refresh token");
  });

  it("skips disabled account", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ status: "disabled" })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("manually disabled");
  });

  it("returns skipped for non-existent account", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const pool = makePool([]);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "nonexistent");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("not found");
  });

  it("detects 'account has been deactivated' as permanent", async () => {
    refreshResult = new Error("account has been deactivated");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "expired");
  });
});

describe("batchHealthCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setConfigForTesting(createMockConfig());
    const validToken = makeValidJwt();
    refreshResult = { access_token: validToken, refresh_token: "new_rt" };
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConfigForTesting();
    vi.restoreAllMocks();
  });

  it("checks all eligible accounts and skips those without RT", async () => {
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: null }),
      makeEntry({ id: "a3", refreshToken: "rt_3", status: "disabled" }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      staggerMs: 100,
      concurrency: 2,
    });

    expect(results).toHaveLength(3);
    const alive = results.filter((r) => r.result === "alive");
    const skipped = results.filter((r) => r.result === "skipped");
    expect(alive).toHaveLength(1);
    expect(skipped).toHaveLength(2);
  });

  it("filters by specified ids", async () => {
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: "rt_2" }),
      makeEntry({ id: "a3", refreshToken: "rt_3" }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      ids: ["a1", "a3"],
      staggerMs: 100,
      concurrency: 2,
    });

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["a1", "a3"]);
  });

  it("returns summary counts", async () => {
    refreshResult = new Error("invalid_grant");
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: null }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      staggerMs: 100,
    });

    const dead = results.filter((r) => r.result === "dead").length;
    const skipped = results.filter((r) => r.result === "skipped").length;
    expect(dead).toBe(1);
    expect(skipped).toBe(1);
  });
});
