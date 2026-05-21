/**
 * Tests for AccountPool.hasAvailableAccounts() — quick check for available accounts
 * without the full acquire overhead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
      max_concurrent_per_account: 3,
    },
    quota: {
      skip_exhausted: true,
    },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn(() => ({
    email: "test@test.com",
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { isTokenExpired } from "@src/auth/jwt-utils.js";
import type { CodexQuota } from "@src/auth/types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 25,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("AccountPool.hasAvailableAccounts", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.mocked(isTokenExpired).mockReturnValue(false);
    pool = new AccountPool({ rotationStrategy: "least_used" });
  });

  it("returns false for empty pool", () => {
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns true when an active account exists", () => {
    pool.addAccount("token-a");
    expect(pool.hasAvailableAccounts()).toBe(true);
  });

  it("returns false when all accounts are rate-limited", () => {
    const id = pool.addAccount("token-a");
    pool.applyRateLimit429(id);
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns false when all accounts are disabled", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "disabled");
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns false when all accounts are banned", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "banned");
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns true when mix of statuses includes at least one active", () => {
    const id1 = pool.addAccount("token-a");
    pool.addAccount("token-b");
    pool.markStatus(id1, "banned");
    expect(pool.hasAvailableAccounts()).toBe(true);
  });

  it("excludes specified entry IDs", () => {
    const id = pool.addAccount("token-a");
    expect(pool.hasAvailableAccounts([id])).toBe(false);
  });

  it("returns true when excluded IDs leave other active accounts", () => {
    const id1 = pool.addAccount("token-a");
    pool.addAccount("token-b");
    expect(pool.hasAvailableAccounts([id1])).toBe(true);
  });

  it("returns false when all active accounts are excluded", () => {
    const id1 = pool.addAccount("token-a");
    const id2 = pool.addAccount("token-b");
    expect(pool.hasAvailableAccounts([id1, id2])).toBe(false);
  });

  it("returns false when active accounts only have cached primary quota exhaustion", () => {
    const id = pool.addAccount("token-a");
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
    }));
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns false when active accounts only have cached secondary quota exhaustion", () => {
    const id = pool.addAccount("token-a");
    pool.updateCachedQuota(id, makeQuota({
      secondary_rate_limit: {
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
    }));
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("returns false when active accounts only have cached code review quota exhaustion", () => {
    const id = pool.addAccount("token-a");
    pool.updateCachedQuota(id, makeQuota({
      code_review_rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }));
    expect(pool.hasAvailableAccounts()).toBe(false);
  });

  it("auto-clears cachedQuota.rate_limit.limit_reached after reset_at passes", () => {
    const id = pool.addAccount("token-a");
    // Apply a 429 with negative retry-after so reset_at is in the past;
    // resetExpiredQuotaWindow (called inside refreshStatus) should auto-clear.
    pool.applyRateLimit429(id, { retryAfterSec: -1 });
    expect(pool.hasAvailableAccounts()).toBe(true);
  });

  it("detects expired tokens via refreshStatus", () => {
    pool.addAccount("token-a");
    vi.mocked(isTokenExpired).mockReturnValue(true);
    expect(pool.hasAvailableAccounts()).toBe(false);
  });
});

describe("AccountPool.isAuthenticated", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.mocked(isTokenExpired).mockReturnValue(false);
    pool = new AccountPool({ rotationStrategy: "least_used" });
  });

  it("returns false for empty pool", () => {
    expect(pool.isAuthenticated()).toBe(false);
  });

  it("returns true when an active non-exhausted account exists", () => {
    pool.addAccount("token-a");
    expect(pool.isAuthenticated()).toBe(true);
  });

  it("returns false when only quota-exhausted accounts exist and skip_exhausted=true (default)", () => {
    const id = pool.addAccount("token-a");
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
    }));
    expect(pool.isAuthenticated()).toBe(false);
  });

  it("returns true when only quota-exhausted accounts exist and skip_exhausted=false (P1 fix)", async () => {
    const { getConfig } = await import("@src/config.js");
    vi.mocked(getConfig).mockReturnValueOnce({
      auth: {
        jwt_token: null,
        rotation_strategy: "least_used",
        rate_limit_backoff_seconds: 60,
        max_concurrent_per_account: 3,
      },
      quota: { skip_exhausted: false },
    } as ReturnType<typeof getConfig>);

    const id = pool.addAccount("token-a");
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
    }));
    expect(pool.isAuthenticated()).toBe(true);
  });

  it("returns false when only disabled accounts exist, regardless of skip_exhausted", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "disabled");
    expect(pool.isAuthenticated()).toBe(false);
  });
});
