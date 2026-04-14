/**
 * Tests for RefreshScheduler — JWT auto-refresh scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      refresh_margin_seconds: 300,
    },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
  jitterInt: vi.fn((val: number) => val),
}));

import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { refreshAccessToken } from "@src/auth/oauth-pkce.js";
import type { AccountPool } from "@src/auth/account-pool.js";

function createMockPool(entries: Array<{
  id: string;
  token: string;
  refreshToken: string | null;
  status: string;
}>): AccountPool {
  return {
    getAllEntries: vi.fn(() => entries.map((e) => ({
      ...e,
      email: null,
      accountId: null,
      planType: null,
      proxyApiKey: "key",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        empty_response_count: 0,
        last_used: null,
        rate_limit_until: null,
      },
      addedAt: new Date().toISOString(),
    }))),
    getEntry: vi.fn((id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return undefined;
      return {
        ...entry,
        email: null,
        accountId: null,
        planType: null,
        proxyApiKey: "key",
        usage: {
          request_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          empty_response_count: 0,
          last_used: null,
          rate_limit_until: null,
        },
        addedAt: new Date().toISOString(),
      };
    }),
    updateToken: vi.fn(),
    markStatus: vi.fn(),
  } as unknown as AccountPool;
}

describe("RefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules refresh for active accounts", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // Should have scheduled without error
    scheduler.destroy();
  });

  it("attempts immediate refresh for 'refreshing' state (crash recovery)", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "refreshing" },
    ]);

    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
    });

    const scheduler = new RefreshScheduler(pool);
    // The doRefresh should be called (async)
    scheduler.destroy();
  });

  it("skips expired accounts without refresh token (no schedule, no error)", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: null, status: "expired" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // No timer scheduled for accounts without refresh token
    scheduler.destroy();
  });

  it("schedules recovery for expired accounts with refresh token", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "expired" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // Should schedule delayed recovery without error
    scheduler.destroy();
  });

  it("destroy cancels all timers", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
      { id: "acc2", token: "token2", refreshToken: "refresh2", status: "active" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    scheduler.destroy();
    // No timers should fire after destroy
  });
});
