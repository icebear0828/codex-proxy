/**
 * Tests for RefreshScheduler concurrency control.
 * Verifies that concurrent token refreshes are bounded by auth.refresh_concurrency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

let mockConfig = {
  auth: {
    refresh_enabled: true,
    refresh_margin_seconds: 300,
    refresh_concurrency: 2,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: () => mockConfig,
}));

// Track concurrent calls
let activeCalls = 0;
let peakConcurrency = 0;
const callLog: string[] = [];

vi.mock("../oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(async (_rt: string) => {
    activeCalls++;
    if (activeCalls > peakConcurrency) peakConcurrency = activeCalls;
    callLog.push(`start:${activeCalls}`);
    // Simulate network delay
    await new Promise((r) => setTimeout(r, 50));
    activeCalls--;
    // Return a fake JWT with exp = now + 1h
    const header = btoa(JSON.stringify({ alg: "RS256" }));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = btoa(JSON.stringify({ exp }));
    return {
      access_token: `${header}.${payload}.sig`,
      refresh_token: "new_rt",
    };
  }),
}));

vi.mock("../jwt-utils.js", () => ({
  decodeJwtPayload: (token: string) => {
    try {
      const parts = token.split(".");
      return JSON.parse(atob(parts[1]));
    } catch {
      return null;
    }
  },
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: (val: number) => val,
  jitterInt: (val: number) => val,
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makePool(count: number) {
  const entries: Array<{
    id: string;
    token: string;
    refreshToken: string;
    status: string;
    email: string | null;
  }> = [];

  // All tokens already expired → triggers immediate refresh
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const expiredPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 }));
  const expiredToken = `${header}.${expiredPayload}.sig`;

  for (let i = 0; i < count; i++) {
    entries.push({
      id: `acc-${i}`,
      token: expiredToken,
      refreshToken: `rt-${i}`,
      status: "active",
      email: null,
    });
  }

  return {
    getAllEntries: () => entries,
    getEntry: (id: string) => entries.find((e) => e.id === id) ?? null,
    markStatus: vi.fn(),
    updateToken: vi.fn((_id: string, _token: string, _rt: string) => {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("RefreshScheduler concurrency control", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    activeCalls = 0;
    peakConcurrency = 0;
    callLog.length = 0;
    mockConfig = {
      auth: {
        refresh_enabled: true,
        refresh_margin_seconds: 300,
        refresh_concurrency: 2,
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits concurrent refreshes to configured value", async () => {
    const pool = makePool(6);

    // Dynamic import to pick up mocks
    const { RefreshScheduler } = await import("../refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool as never);

    // Let all timers and promises settle
    await vi.advanceTimersByTimeAsync(5000);

    expect(peakConcurrency).toBeLessThanOrEqual(2);
    // All 6 accounts should eventually be refreshed
    expect(pool.updateToken).toHaveBeenCalledTimes(6);

    scheduler.destroy();
  });

  it("respects higher concurrency config", async () => {
    mockConfig.auth.refresh_concurrency = 4;
    const pool = makePool(8);

    const { RefreshScheduler } = await import("../refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool as never);

    await vi.advanceTimersByTimeAsync(5000);

    expect(peakConcurrency).toBeLessThanOrEqual(4);
    expect(pool.updateToken).toHaveBeenCalledTimes(8);

    scheduler.destroy();
  });

  it("works with concurrency=1 (serial)", async () => {
    mockConfig.auth.refresh_concurrency = 1;
    const pool = makePool(3);

    const { RefreshScheduler } = await import("../refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool as never);

    await vi.advanceTimersByTimeAsync(5000);

    expect(peakConcurrency).toBe(1);
    expect(pool.updateToken).toHaveBeenCalledTimes(3);

    scheduler.destroy();
  });
});
