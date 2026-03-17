/**
 * Tests for AccountPool core scheduling logic.
 * Migrated from src/auth/__tests__/ with @src/ path aliases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing AccountPool
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

// Mock paths
vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

// Mock config
vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: {
      proxy_api_key: null,
    },
  })),
}));

// Mock JWT utilities — all tokens are "valid"
vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

// Mock jitter to return the exact value (no randomness in tests)
vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

// Mock model-store for model-aware selection tests
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { getConfig } from "@src/config.js";
import { isTokenExpired } from "@src/auth/jwt-utils.js";
import { getModelPlanTypes } from "@src/models/model-store.js";

describe("AccountPool", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.mocked(isTokenExpired).mockReturnValue(false);
    vi.mocked(getConfig).mockReturnValue({
      auth: {
        jwt_token: null,
        rotation_strategy: "least_used",
        rate_limit_backoff_seconds: 60,
      },
      server: { proxy_api_key: null },
    } as ReturnType<typeof getConfig>);
    pool = new AccountPool();
  });

  afterEach(() => {
    pool.destroy();
  });

  describe("addAccount + acquire", () => {
    it("adds an account and acquires it", () => {
      pool.addAccount("token-aaa");
      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.token).toBe("token-aaa");
    });

    it("deduplicates by accountId", () => {
      const id1 = pool.addAccount("token-aaa");
      const id2 = pool.addAccount("token-aaa");
      expect(id1).toBe(id2);
    });

    it("returns null when no accounts exist", () => {
      expect(pool.acquire()).toBeNull();
    });
  });

  describe("least_used rotation", () => {
    it("selects the account with lowest request_count", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const first = pool.acquire()!;
      pool.release(first.entryId, { input_tokens: 10, output_tokens: 5 });

      const second = pool.acquire()!;
      expect(second.entryId).not.toBe(first.entryId);
    });
  });

  describe("round_robin rotation", () => {
    it("cycles through accounts in order", () => {
      vi.mocked(getConfig).mockReturnValue({
        auth: {
          jwt_token: null,
          rotation_strategy: "round_robin",
          rate_limit_backoff_seconds: 60,
        },
        server: { proxy_api_key: null },
      } as ReturnType<typeof getConfig>);

      const rrPool = new AccountPool();
      rrPool.addAccount("token-aaa");
      rrPool.addAccount("token-bbb");

      const a1 = rrPool.acquire()!;
      rrPool.release(a1.entryId);

      const a2 = rrPool.acquire()!;
      rrPool.release(a2.entryId);

      const a3 = rrPool.acquire()!;
      rrPool.release(a3.entryId);

      expect(a3.entryId).toBe(a1.entryId);
      expect(a1.entryId).not.toBe(a2.entryId);

      rrPool.destroy();
    });
  });

  describe("release", () => {
    it("increments request_count and token usage", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 100, output_tokens: 50 });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
      expect(accounts[0].usage.input_tokens).toBe(100);
      expect(accounts[0].usage.output_tokens).toBe(50);
      expect(accounts[0].usage.last_used).not.toBeNull();
    });

    it("unlocks account after release", () => {
      pool.addAccount("token-aaa");

      const a1 = pool.acquire()!;
      expect(pool.acquire()).toBeNull();

      pool.release(a1.entryId);
      expect(pool.acquire()).not.toBeNull();
    });
  });

  describe("markRateLimited", () => {
    it("marks account as rate_limited and skips it in acquire", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const first = pool.acquire()!;
      pool.markRateLimited(first.entryId);

      const summary = pool.getPoolSummary();
      expect(summary.rate_limited).toBe(1);
      expect(summary.active).toBe(1);

      const second = pool.acquire()!;
      expect(second.entryId).not.toBe(first.entryId);
    });

    it("countRequest option increments usage on 429", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId, { countRequest: true });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
    });

    it("auto-recovers after rate_limit_until passes", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId, { retryAfterSec: -1 });

      const summary = pool.getPoolSummary();
      expect(summary.active).toBe(1);
      expect(summary.rate_limited).toBe(0);
    });
  });

  describe("stale lock auto-release", () => {
    it("releases locks older than 5 minutes", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;

      const locks = (pool as unknown as { acquireLocks: Map<string, number> }).acquireLocks;
      locks.set(acquired.entryId, Date.now() - 6 * 60 * 1000);

      const reacquired = pool.acquire()!;
      expect(reacquired).not.toBeNull();
      expect(reacquired.entryId).toBe(acquired.entryId);
    });
  });

  describe("expired tokens", () => {
    it("skips expired accounts in acquire", () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      pool.addAccount("token-expired");

      expect(pool.acquire()).toBeNull();
      expect(pool.getPoolSummary().expired).toBe(1);
    });
  });

  describe("removeAccount", () => {
    it("removes an account and clears its lock", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.removeAccount(acquired.entryId);

      expect(pool.getPoolSummary().total).toBe(0);
      expect(pool.acquire()).toBeNull();
    });
  });

  describe("resetUsage", () => {
    it("resets counters to zero", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 100, output_tokens: 50 });
      pool.resetUsage(acquired.entryId);

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(0);
      expect(accounts[0].usage.input_tokens).toBe(0);
      expect(accounts[0].usage.output_tokens).toBe(0);
    });
  });

  describe("validateProxyApiKey", () => {
    it("validates per-account proxy API key", () => {
      pool.addAccount("token-aaa");

      const accounts = pool.getAccounts();
      const entry = pool.getEntry(accounts[0].id)!;
      expect(pool.validateProxyApiKey(entry.proxyApiKey)).toBe(true);
      expect(pool.validateProxyApiKey("wrong-key")).toBe(false);
    });

    it("validates config-level proxy API key", () => {
      vi.mocked(getConfig).mockReturnValue({
        auth: {
          jwt_token: null,
          rotation_strategy: "least_used",
          rate_limit_backoff_seconds: 60,
        },
        server: { proxy_api_key: "global-key-123" },
      } as ReturnType<typeof getConfig>);

      expect(pool.validateProxyApiKey("global-key-123")).toBe(true);
    });
  });

  // ── Tier 1: Branch coverage additions ────────────────────────────

  describe("release without usage", () => {
    it("increments window_request_count but not tokens when no usage provided", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId); // no usage param

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
      expect(accounts[0].usage.last_used).not.toBeNull();
      expect(accounts[0].usage.window_request_count).toBe(1);
      // Token counts should stay at zero
      expect(accounts[0].usage.input_tokens).toBe(0);
      expect(accounts[0].usage.output_tokens).toBe(0);
      expect(accounts[0].usage.window_input_tokens).toBe(0);
      expect(accounts[0].usage.window_output_tokens).toBe(0);
    });
  });

  describe("markRateLimited without countRequest", () => {
    it("does not increment request_count when countRequest not set", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId); // no options

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(0);
      expect(accounts[0].usage.window_request_count).toBe(0);
    });
  });

  describe("model-aware selection", () => {
    it("falls back to all accounts when model has plan requirements but no account matches", () => {
      pool.addAccount("token-aaa"); // planType defaults to "free"
      pool.addAccount("token-bbb");

      // Mock getModelPlanTypes to require "pro" plan
      vi.mocked(getModelPlanTypes).mockReturnValue(["pro"]);

      // Should fall back to available accounts instead of returning null,
      // because the backend model list per plan is incomplete
      const acquired = pool.acquire({ model: "gpt-pro-model" });
      expect(acquired).not.toBeNull();
    });
  });

  describe("window auto-reset", () => {
    it("catches up across multiple expired windows", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 10, output_tokens: 5 });

      const entry = pool.getEntry(acquired.entryId)!;
      const nowSec = Math.floor(Date.now() / 1000);
      // Set window_reset_at 3 windows ago (window = 3600s)
      entry.usage.window_reset_at = nowSec - 3 * 3600;
      entry.usage.limit_window_seconds = 3600;
      entry.usage.window_request_count = 5;
      entry.usage.window_input_tokens = 100;
      entry.usage.window_output_tokens = 50;

      // Trigger refreshStatus via getAccounts
      const accounts = pool.getAccounts();

      // Window counters should be reset
      expect(accounts[0].usage.window_request_count).toBe(0);
      expect(accounts[0].usage.window_input_tokens).toBe(0);
      expect(accounts[0].usage.window_output_tokens).toBe(0);
      // Next window_reset_at should be in the future
      expect(accounts[0].usage.window_reset_at).not.toBeNull();
      expect(accounts[0].usage.window_reset_at!).toBeGreaterThan(nowSec);
    });

    it("sets window_reset_at to null when limit_window_seconds is null", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId);

      const entry = pool.getEntry(acquired.entryId)!;
      const nowSec = Math.floor(Date.now() / 1000);
      entry.usage.window_reset_at = nowSec - 100; // expired
      entry.usage.limit_window_seconds = null;
      entry.usage.window_request_count = 5;

      const accounts = pool.getAccounts();

      expect(accounts[0].usage.window_request_count).toBe(0);
      expect(accounts[0].usage.window_reset_at).toBeNull();
    });
  });

  describe("syncRateLimitWindow", () => {
    it("does not reset counters when timestamp is unchanged", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 10, output_tokens: 5 });

      const entry = pool.getEntry(acquired.entryId)!;
      // Use a future timestamp so refreshStatus does NOT auto-reset
      const futureResetAt = Math.floor(Date.now() / 1000) + 7200;
      entry.usage.window_reset_at = futureResetAt;

      // Sync with the SAME timestamp — should be a no-op
      pool.syncRateLimitWindow(acquired.entryId, futureResetAt, 3600);

      // Counters should NOT be reset (same timestamp)
      const afterEntry = pool.getEntry(acquired.entryId)!;
      expect(afterEntry.usage.window_request_count).toBe(1);
      expect(afterEntry.usage.window_input_tokens).toBe(10);
      expect(afterEntry.usage.window_output_tokens).toBe(5);
    });
  });

  describe("least_used window_reset_at tiebreaker", () => {
    it("prefers accounts with earlier window_reset_at on same request_count", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const accounts = pool.getAccounts();
      const entryA = pool.getEntry(accounts[0].id)!;
      const entryB = pool.getEntry(accounts[1].id)!;

      const nowSec = Math.floor(Date.now() / 1000);
      // A resets in 1 hour, B resets in 5 hours
      entryA.usage.window_reset_at = nowSec + 3600;
      entryB.usage.window_reset_at = nowSec + 18000;

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId);
      // Should prefer A (sooner reset)
      expect(acquired.entryId).toBe(entryA.id);
    });

    it("ranks accounts with null window_reset_at after those with known values", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const accounts = pool.getAccounts();
      const entryA = pool.getEntry(accounts[0].id)!;
      const entryB = pool.getEntry(accounts[1].id)!;

      // A has no window info, B has a known reset
      entryA.usage.window_reset_at = null;
      entryB.usage.window_reset_at = Math.floor(Date.now() / 1000) + 7200;

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId);
      // Should prefer B (known reset) over A (unknown/Infinity)
      expect(acquired.entryId).toBe(entryB.id);
    });

    it("falls back to last_used LRU when window_reset_at is equal", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const accounts = pool.getAccounts();
      const entryA = pool.getEntry(accounts[0].id)!;
      const entryB = pool.getEntry(accounts[1].id)!;

      const resetAt = Math.floor(Date.now() / 1000) + 3600;
      entryA.usage.window_reset_at = resetAt;
      entryB.usage.window_reset_at = resetAt;
      // A used more recently, B used earlier → B should be preferred (LRU)
      entryA.usage.last_used = new Date(Date.now() - 1000).toISOString();
      entryB.usage.last_used = new Date(Date.now() - 60000).toISOString();

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId);
      expect(acquired.entryId).toBe(entryB.id);
    });
  });

  describe("loadPersisted edge cases", () => {
    it("skips entries without id or token", async () => {
      const { existsSync: mockExistsSync, readFileSync: mockReadFileSync } = await import("fs");

      vi.mocked(mockExistsSync).mockReturnValue(false); // no legacy
      vi.mocked(mockReadFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      // Create fresh pool with specific persisted data
      vi.mocked(mockExistsSync).mockImplementation((path: unknown) => {
        if (typeof path === "string" && path.includes("accounts.json")) return true;
        return false;
      });
      vi.mocked(mockReadFileSync).mockReturnValue(JSON.stringify({
        accounts: [
          { id: null, token: "valid-token", usage: {} },       // missing id
          { id: "entry1", token: null, usage: {} },              // missing token
          { id: "entry2", token: "valid-token-2", usage: { request_count: 0, input_tokens: 0, output_tokens: 0, last_used: null, rate_limit_until: null }, planType: "free", email: "test@test.com", accountId: "acct-123" },
        ],
      }));

      const freshPool = new AccountPool();
      expect(freshPool.getPoolSummary().total).toBe(1); // only entry2 loaded
      freshPool.destroy();
    });

    it("handles invalid JSON gracefully", async () => {
      const { existsSync: mockExistsSync, readFileSync: mockReadFileSync } = await import("fs");

      vi.mocked(mockExistsSync).mockImplementation((path: unknown) => {
        if (typeof path === "string" && path.includes("accounts.json")) return true;
        return false;
      });
      vi.mocked(mockReadFileSync).mockReturnValue("NOT VALID JSON {{{");

      const freshPool = new AccountPool();
      expect(freshPool.getPoolSummary().total).toBe(0);
      freshPool.destroy();
    });
  });
});
