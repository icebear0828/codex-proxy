/**
 * Tests for AccountPool core scheduling logic.
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
  isPlanFetched: vi.fn(() => true),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { getConfig } from "@src/config.js";
import { isTokenExpired, extractUserProfile } from "@src/auth/jwt-utils.js";
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
        max_concurrent_per_account: 1,
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as ReturnType<typeof getConfig>);
    vi.mocked(getModelPlanTypes).mockReturnValue([]);
    // extractUserProfile: derive plan from token name for test flexibility
    vi.mocked(extractUserProfile).mockImplementation((token: string) => {
      let plan = "free";
      if (token.includes("team")) plan = "team";
      else if (token.includes("plus")) plan = "plus";
      else if (token.includes("enterprise")) plan = "enterprise";
      return { email: `${token.slice(0, 8)}@test.com`, chatgpt_plan_type: plan };
    });
    pool = new AccountPool();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic operations ──────────────────────────────────────────────

  describe("basic acquire/release", () => {
    it("acquires and releases accounts", () => {
      pool.addAccount("token-aaa");
      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.token).toBe("token-aaa");
      pool.release(acquired!.entryId);
    });

    it("deduplicates by accountId", () => {
      const id1 = pool.addAccount("token-aaa");
      const id2 = pool.addAccount("token-aaa");
      expect(id1).toBe(id2);
    });

    it("returns null when no accounts exist", () => {
      expect(pool.acquire()).toBeNull();
    });

    it("returns null when all accounts are locked", () => {
      pool.addAccount("token-aaa");
      const a = pool.acquire()!;
      expect(pool.acquire()).toBeNull();
      pool.release(a.entryId);
    });

    it("returns null when all accounts are expired", () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      pool.addAccount("token-expired");
      expect(pool.acquire()).toBeNull();
    });
  });

  // ── Rotation strategies ───────────────────────────────────────────

  describe("least_used strategy", () => {
    it("selects the account with fewest requests", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const first = pool.acquire()!;
      pool.release(first.entryId, { input_tokens: 100, output_tokens: 50 });

      const second = pool.acquire()!;
      expect(second.token).toBe("token-bbb");
      pool.release(second.entryId);
    });
  });

  describe("round_robin strategy", () => {
    it("cycles through accounts in order", () => {
      vi.mocked(getConfig).mockReturnValue({
        auth: {
          jwt_token: null,
          rotation_strategy: "round_robin",
          rate_limit_backoff_seconds: 60,
        },
      } as ReturnType<typeof getConfig>);
      const rrPool = new AccountPool();
      rrPool.addAccount("token-aaa");
      rrPool.addAccount("token-bbb");

      const a1 = rrPool.acquire()!;
      rrPool.release(a1.entryId);
      const a2 = rrPool.acquire()!;
      rrPool.release(a2.entryId);
      expect(a1.token).not.toBe(a2.token);
    });
  });

  // ── Usage tracking ────────────────────────────────────────────────

  describe("usage tracking", () => {
    it("tracks request count and tokens", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 100, output_tokens: 50 });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
      expect(accounts[0].usage.input_tokens).toBe(100);
      expect(accounts[0].usage.output_tokens).toBe(50);
    });

    it("increments counters on repeated releases", () => {
      pool.addAccount("token-aaa");

      const a1 = pool.acquire()!;
      pool.release(a1.entryId, { input_tokens: 100, output_tokens: 50 });
      const a2 = pool.acquire()!;
      pool.release(a2.entryId, { input_tokens: 200, output_tokens: 100 });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(2);
      expect(accounts[0].usage.input_tokens).toBe(300);
      expect(accounts[0].usage.output_tokens).toBe(150);
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("marks account as rate_limited", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId, { retryAfterSeconds: 120 });

      const accounts = pool.getAccounts();
      expect(accounts[0].status).toBe("rate_limited");
      expect(pool.acquire()).toBeNull();
    });

    it("uses configured backoff when retryAfterSeconds not provided", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId);

      const accounts = pool.getAccounts();
      expect(accounts[0].status).toBe("rate_limited");
    });

    it("does not count rate limit release as a request", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId); // no options

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(0);
      expect(accounts[0].usage.window_request_count).toBe(0);
    });
  });

  // ── Model-aware selection ─────────────────────────────────────────

  describe("model-aware selection", () => {
    describe("free-only pool", () => {
      it("returns null when model requires team plan", () => {
        pool.addAccount("token-free-1");
        pool.addAccount("token-free-2");

        // gpt-5.4 only available for team
        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).toBeNull();
      });

      it("acquires normally for models available to free", () => {
        pool.addAccount("token-free-1");

        // gpt-5.2-codex available for free
        vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);

        const acquired = pool.acquire({ model: "gpt-5.2-codex" });
        expect(acquired).not.toBeNull();
        expect(acquired!.token).toBe("token-free-1");
      });

      it("acquires when model has no plan info (unknown model)", () => {
        pool.addAccount("token-free-1");

        vi.mocked(getModelPlanTypes).mockReturnValue([]);

        const acquired = pool.acquire({ model: "unknown-new-model" });
        expect(acquired).not.toBeNull();
      });
    });

    describe("team-only pool", () => {
      it("acquires team account for team-only model", () => {
        pool.addAccount("token-team-1");

        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).not.toBeNull();
        expect(acquired!.token).toBe("token-team-1");
      });

      it("acquires team account for models available to all plans", () => {
        pool.addAccount("token-team-1");

        vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);

        const acquired = pool.acquire({ model: "gpt-5.2-codex" });
        expect(acquired).not.toBeNull();
      });
    });

    describe("mixed pool (free + team)", () => {
      beforeEach(() => {
        pool.addAccount("token-free-x");
        pool.addAccount("token-team-x");
      });

      it("prefers team account for team-only model", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).not.toBeNull();
        expect(acquired!.token).toBe("token-team-x");
      });

      it("can use either account for shared models", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);

        const acquired = pool.acquire({ model: "gpt-5.2-codex" });
        expect(acquired).not.toBeNull();
        // Both are eligible, least_used picks one
      });

      it("falls back correctly when team account is locked", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        const first = pool.acquire({ model: "gpt-5.4" })!;
        expect(first.token).toBe("token-team-x");

        // Team account is locked now, free can't serve gpt-5.4
        const second = pool.acquire({ model: "gpt-5.4" });
        expect(second).toBeNull();
      });

      it("team-only model skips free even when team is rate limited", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        // Rate limit the team account
        const team = pool.acquire({ model: "gpt-5.4" })!;
        pool.markRateLimited(team.entryId, { retryAfterSeconds: 3600 });

        // No team accounts available, should return null
        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).toBeNull();
      });

      it("shared model can use free when team is locked", () => {
        // Lock team account on a team-only model
        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
        const team = pool.acquire({ model: "gpt-5.4" })!;
        expect(team.token).toBe("token-team-x");

        // Now request a shared model — free should serve it
        vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);
        const free = pool.acquire({ model: "gpt-5.2-codex" });
        expect(free).not.toBeNull();
        expect(free!.token).toBe("token-free-x");
      });
    });

    describe("plus pool", () => {
      it("acquires plus account for plus-eligible model", () => {
        pool.addAccount("token-plus-1");

        vi.mocked(getModelPlanTypes).mockReturnValue(["plus", "team"]);

        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).not.toBeNull();
        expect(acquired!.token).toBe("token-plus-1");
      });
    });

    describe("mixed pool (free + plus + team)", () => {
      beforeEach(() => {
        pool.addAccount("token-free-m");
        pool.addAccount("token-plus-m");
        pool.addAccount("token-team-m");
      });

      it("routes team-only model to team or plus", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["plus", "team"]);

        const acquired = pool.acquire({ model: "gpt-5.4" });
        expect(acquired).not.toBeNull();
        // Should be plus or team, not free
        expect(acquired!.token).not.toBe("token-free-m");
      });

      it("routes free-compatible model to any account", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["free", "plus", "team"]);

        const tokens: string[] = [];
        for (let i = 0; i < 3; i++) {
          const a = pool.acquire({ model: "gpt-5.2-codex" })!;
          tokens.push(a.token);
          pool.release(a.entryId);
        }
        // All three accounts should be eligible
        expect(tokens.length).toBe(3);
      });

      it("returns null for model no plan can serve", () => {
        vi.mocked(getModelPlanTypes).mockReturnValue(["enterprise"]);

        const acquired = pool.acquire({ model: "gpt-enterprise-only" });
        expect(acquired).toBeNull();
      });
    });

    describe("no model specified", () => {
      it("acquires any available account when no model given", () => {
        pool.addAccount("token-aaa");
        const acquired = pool.acquire();
        expect(acquired).not.toBeNull();
      });

      it("acquires any available account when model is undefined", () => {
        pool.addAccount("token-aaa");
        const acquired = pool.acquire({ model: undefined });
        expect(acquired).not.toBeNull();
      });
    });

    describe("excludeIds interaction", () => {
      it("respects excludeIds even for matching plan accounts", () => {
        pool.addAccount("token-team-only");

        vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);

        const first = pool.acquire({ model: "gpt-5.4" })!;
        pool.release(first.entryId);

        // Exclude the only team account
        const second = pool.acquire({ model: "gpt-5.4", excludeIds: [first.entryId] });
        expect(second).toBeNull();
      });
    });
  });


  // ── getDistinctPlanAccounts ───────────────────────────────────────

  describe("getDistinctPlanAccounts", () => {
    it("returns one account per plan type", () => {
      pool.addAccount("token-free-1");
      pool.addAccount("token-free-2");
      pool.addAccount("token-team-1");

      const distinct = pool.getDistinctPlanAccounts();
      const plans = distinct.map((d) => d.planType);
      expect(plans).toContain("free");
      expect(plans).toContain("team");
      expect(distinct.length).toBe(2);
    });
  });
});
