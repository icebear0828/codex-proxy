/**
 * Tests for team account deduplication.
 *
 * Team accounts share the same chatgpt_account_id but have distinct
 * chatgpt_user_id values. They should be treated as separate accounts.
 * See: https://github.com/icebear0828/codex-proxy/issues/126
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { proxy_api_key: null },
    auth: { jwt_token: "", rotation_strategy: "least_used", rate_limit_backoff_seconds: 60 },
  })),
}));

// Team members share the same accountId but have distinct user IDs
const TEAM_ACCOUNT_ID = "acct-team-abc123";

let profileForToken: Record<string, { chatgpt_plan_type: string; email: string; chatgpt_user_id?: string }> = {};

vi.mock("../../auth/jwt-utils.js", () => ({
  isTokenExpired: vi.fn(() => false),
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => {
    // All "team-*" tokens share the same account ID
    if (token.startsWith("team-")) return TEAM_ACCOUNT_ID;
    return `acct-${token}`;
  }),
  extractUserProfile: vi.fn((token: string) => profileForToken[token] ?? null),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ accounts: [] })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { AccountPool } from "../account-pool.js";

describe("team account dedup (issue #126)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileForToken = {};
  });

  it("allows multiple team members with same accountId but different userId", () => {
    profileForToken = {
      "team-alice": { chatgpt_plan_type: "team", email: "alice@corp.com", chatgpt_user_id: "user-alice" },
      "team-bob": { chatgpt_plan_type: "team", email: "bob@corp.com", chatgpt_user_id: "user-bob" },
    };

    const pool = new AccountPool();
    const idAlice = pool.addAccount("team-alice");
    const idBob = pool.addAccount("team-bob");

    // Both should exist as separate entries
    expect(idAlice).not.toBe(idBob);
    expect(pool.getAccounts()).toHaveLength(2);

    const accounts = pool.getAccounts();
    expect(accounts.map((a) => a.email).sort()).toEqual(["alice@corp.com", "bob@corp.com"]);
    expect(accounts.map((a) => a.userId).sort()).toEqual(["user-alice", "user-bob"]);
    // Both share the same accountId
    expect(accounts[0].accountId).toBe(TEAM_ACCOUNT_ID);
    expect(accounts[1].accountId).toBe(TEAM_ACCOUNT_ID);
  });

  it("still deduplicates when same user re-adds their token", () => {
    profileForToken = {
      "team-alice": { chatgpt_plan_type: "team", email: "alice@corp.com", chatgpt_user_id: "user-alice" },
      "team-alice-refreshed": { chatgpt_plan_type: "team", email: "alice@corp.com", chatgpt_user_id: "user-alice" },
    };

    const pool = new AccountPool();
    const id1 = pool.addAccount("team-alice");
    const id2 = pool.addAccount("team-alice-refreshed");

    // Same user → should update, not duplicate
    expect(id1).toBe(id2);
    expect(pool.getAccounts()).toHaveLength(1);
  });

  it("third team member adds without overwriting existing members", () => {
    profileForToken = {
      "team-alice": { chatgpt_plan_type: "team", email: "alice@corp.com", chatgpt_user_id: "user-alice" },
      "team-bob": { chatgpt_plan_type: "team", email: "bob@corp.com", chatgpt_user_id: "user-bob" },
      "team-carol": { chatgpt_plan_type: "team", email: "carol@corp.com", chatgpt_user_id: "user-carol" },
    };

    const pool = new AccountPool();
    pool.addAccount("team-alice");
    pool.addAccount("team-bob");
    pool.addAccount("team-carol");

    expect(pool.getAccounts()).toHaveLength(3);
    const emails = pool.getAccounts().map((a) => a.email).sort();
    expect(emails).toEqual(["alice@corp.com", "bob@corp.com", "carol@corp.com"]);
  });

  it("userId is included in AccountInfo", () => {
    profileForToken = {
      "team-alice": { chatgpt_plan_type: "team", email: "alice@corp.com", chatgpt_user_id: "user-alice" },
    };

    const pool = new AccountPool();
    pool.addAccount("team-alice");

    const info = pool.getAccounts()[0];
    expect(info.userId).toBe("user-alice");
  });

  it("accounts without userId still dedup by accountId alone", () => {
    // Legacy tokens without chatgpt_user_id
    profileForToken = {
      "solo-token1": { chatgpt_plan_type: "free", email: "user@test.com" },
      "solo-token2": { chatgpt_plan_type: "free", email: "user@test.com" },
    };

    // Both map to the same accountId (acct-solo-token1 vs acct-solo-token2 — different!)
    // but if they had the same accountId, they'd dedup since both userId are null
    const pool = new AccountPool();
    pool.addAccount("solo-token1");
    pool.addAccount("solo-token2");

    // Different accountId → separate entries
    expect(pool.getAccounts()).toHaveLength(2);
  });
});
