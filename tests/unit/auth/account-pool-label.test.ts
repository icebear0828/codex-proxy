/**
 * Tests for account label (user-editable disambiguation).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";

describe("account label", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig());
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("new accounts have label=null", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    const accounts = pool.getAccounts();
    expect(accounts[0].label).toBeNull();
  });

  it("setLabel updates label and returns true", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    const ok = pool.setLabel(id, "Team Alpha");
    expect(ok).toBe(true);
    expect(pool.getAccounts()[0].label).toBe("Team Alpha");
  });

  it("setLabel returns false for nonexistent account", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    expect(pool.setLabel("nonexistent", "test")).toBe(false);
  });

  it("setLabel with null clears existing label", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    pool.setLabel(id, "Personal");
    pool.setLabel(id, null);
    expect(pool.getAccounts()[0].label).toBeNull();
  });

  it("dedup preserves existing label on re-add", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const jwt = createValidJwt({ accountId: "a1", email: "a1@test.com" });
    const id = pool.addAccount(jwt);
    pool.setLabel(id, "My Team");

    // Re-add same account (same accountId + userId → dedup)
    const id2 = pool.addAccount(jwt);
    expect(id2).toBe(id);
    expect(pool.getAccounts()[0].label).toBe("My Team");
  });

  it("label is included in getAccounts() response", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    pool.setLabel(id, "Production");
    const info = pool.getAccounts()[0];
    expect(info).toHaveProperty("label", "Production");
  });

  it("label persists through getEntry()", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    pool.setLabel(id, "Dev Team");
    const entry = pool.getEntry(id);
    expect(entry?.label).toBe("Dev Team");
  });

  it("label is included in getAllEntries()", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));
    pool.setLabel(id, "Staging");
    const entries = pool.getAllEntries();
    expect(entries[0].label).toBe("Staging");
  });
});
