/**
 * Tests for team account deduplication.
 *
 * Team accounts share the same chatgpt_account_id but have distinct
 * chatgpt_user_id values. They should be treated as separate accounts.
 * See: https://github.com/icebear0828/codex-proxy/issues/126
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";

const TEAM_ACCOUNT_ID = "acct-team-abc123";

describe("team account dedup (issue #126)", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig());
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("allows multiple team members with same accountId but different userId", () => {
    const jwtAlice = createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-alice", email: "alice@corp.com", planType: "team" });
    const jwtBob = createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-bob", email: "bob@corp.com", planType: "team" });

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const idAlice = pool.addAccount(jwtAlice);
    const idBob = pool.addAccount(jwtBob);

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
    // Same userId → same identity, different token (refreshed)
    const jwt1 = createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-alice", email: "alice@corp.com", planType: "team" });
    const jwt2 = createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-alice", email: "alice@corp.com", planType: "team", expInSeconds: 7200 });

    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id1 = pool.addAccount(jwt1);
    const id2 = pool.addAccount(jwt2);

    // Same user → should update, not duplicate
    expect(id1).toBe(id2);
    expect(pool.getAccounts()).toHaveLength(1);
  });

  it("third team member adds without overwriting existing members", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-alice", email: "alice@corp.com", planType: "team" }));
    pool.addAccount(createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-bob", email: "bob@corp.com", planType: "team" }));
    pool.addAccount(createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-carol", email: "carol@corp.com", planType: "team" }));

    expect(pool.getAccounts()).toHaveLength(3);
    const emails = pool.getAccounts().map((a) => a.email).sort();
    expect(emails).toEqual(["alice@corp.com", "bob@corp.com", "carol@corp.com"]);
  });

  it("userId is included in AccountInfo", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: TEAM_ACCOUNT_ID, userId: "user-alice", email: "alice@corp.com", planType: "team" }));

    const info = pool.getAccounts()[0];
    expect(info.userId).toBe("user-alice");
  });

  it("accounts without userId still dedup by accountId alone", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    // Two accounts with different accountIds — both should be added (no dedup)
    pool.addAccount(createValidJwt({ accountId: "acct-solo-1", email: "user1@test.com" }));
    pool.addAccount(createValidJwt({ accountId: "acct-solo-2", email: "user2@test.com" }));

    // Different accountId → separate entries
    expect(pool.getAccounts()).toHaveLength(2);
  });
});
