/**
 * Tests for createMemoryPersistence() + account-pool-setup.ts helpers.
 *
 * This file demonstrates the new zero-vi.mock pattern:
 *   - No vi.mock("fs"), vi.mock("paths"), vi.mock("jwt-utils") in this file
 *   - Uses createMemoryPersistence() to bypass fs entirely
 *   - Uses createValidJwt() for real JWT parsing (no mock needed)
 *   - Only account-pool-setup.ts provides the 3 required module mocks
 */

// MUST be imported before @src/ imports to activate vi.mock declarations
import "@helpers/account-pool-setup.js";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";

// ── createMemoryPersistence unit tests ──────────────────────────────────────

describe("createMemoryPersistence", () => {
  it("load returns empty entries by default", () => {
    const p = createMemoryPersistence();
    const { entries, needsPersist } = p.load();
    expect(entries).toEqual([]);
    expect(needsPersist).toBe(false);
  });

  it("save + load round-trips entries", () => {
    const p = createMemoryPersistence();
    const fakeEntry = { id: "e1", token: "tok", status: "active" } as Parameters<typeof p.save>[0][0];
    p.save([fakeEntry]);
    const { entries } = p.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("e1");
  });

  it("load returns copies (mutations don't affect store)", () => {
    const p = createMemoryPersistence();
    const fakeEntry = { id: "e1", token: "tok", status: "active" } as Parameters<typeof p.save>[0][0];
    p.save([fakeEntry]);
    const { entries } = p.load();
    entries[0].id = "mutated";
    expect(p._store[0].id).toBe("e1");
  });

  it("accepts pre-populated initial entries", () => {
    const fakeEntry = { id: "pre1", token: "tok", status: "active" } as Parameters<typeof createMemoryPersistence>[0][0];
    const p = createMemoryPersistence([fakeEntry]);
    const { entries } = p.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("pre1");
  });
});

// ── AccountPool + helpers integration tests ──────────────────────────────────

describe("AccountPool with createMemoryPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds account using real JWT parsing (no jwt-utils mock)", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const jwt = createValidJwt({ email: "alice@test.com", planType: "team" });
    pool.addAccount(jwt);
    const accounts = pool.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("alice@test.com");
    expect(accounts[0].planType).toBe("team");
  });

  it("multiple accounts are tracked independently", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));
    pool.addAccount(createValidJwt({ accountId: "a2", email: "b@test.com" }));
    expect(pool.getAccounts()).toHaveLength(2);
  });

  it("deduplicates accounts by accountId + userId", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const jwt = createValidJwt({ accountId: "same-id", email: "user@test.com" });
    pool.addAccount(jwt);
    pool.addAccount(jwt); // same token = same accountId
    expect(pool.getAccounts()).toHaveLength(1);
  });

  it("persistence is in-memory — no fs calls", () => {
    const mem = createMemoryPersistence();
    const pool = new AccountPool({ persistence: mem });
    const jwt = createValidJwt({ email: "x@test.com" });
    pool.addAccount(jwt);
    pool.persistNow();
    // Verify account was saved to in-memory store
    expect(mem._store).toHaveLength(1);
    expect(mem._store[0].email).toBe("x@test.com");
  });

  it("acquire returns null when pool is empty", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    expect(pool.acquire()).toBeNull();
  });

  it("acquire returns an account after addAccount", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ email: "user@test.com" }));
    const result = pool.acquire();
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
  });
});
