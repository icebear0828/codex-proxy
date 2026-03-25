/**
 * Tests for account label (user-editable disambiguation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { proxy_api_key: null },
    auth: { jwt_token: "", rotation_strategy: "least_used", rate_limit_backoff_seconds: 60 },
  })),
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  isTokenExpired: vi.fn(() => false),
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token}@test.com`,
    chatgpt_plan_type: "team",
    chatgpt_user_id: `uid-${token}`,
  })),
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

describe("account label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("new accounts have label=null", () => {
    const pool = new AccountPool();
    pool.addAccount("tok-1");
    const accounts = pool.getAccounts();
    expect(accounts[0].label).toBeNull();
  });

  it("setLabel updates label and returns true", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    const ok = pool.setLabel(id, "Team Alpha");
    expect(ok).toBe(true);
    expect(pool.getAccounts()[0].label).toBe("Team Alpha");
  });

  it("setLabel returns false for nonexistent account", () => {
    const pool = new AccountPool();
    expect(pool.setLabel("nonexistent", "test")).toBe(false);
  });

  it("setLabel with null clears existing label", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    pool.setLabel(id, "Personal");
    pool.setLabel(id, null);
    expect(pool.getAccounts()[0].label).toBeNull();
  });

  it("dedup preserves existing label on re-add", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    pool.setLabel(id, "My Team");

    // Re-add same account (same accountId + userId → dedup)
    const id2 = pool.addAccount("tok-1");
    expect(id2).toBe(id);
    expect(pool.getAccounts()[0].label).toBe("My Team");
  });

  it("label is included in getAccounts() response", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    pool.setLabel(id, "Production");
    const info = pool.getAccounts()[0];
    expect(info).toHaveProperty("label", "Production");
  });

  it("label persists through getEntry()", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    pool.setLabel(id, "Dev Team");
    const entry = pool.getEntry(id);
    expect(entry?.label).toBe("Dev Team");
  });

  it("label is included in getAllEntries()", () => {
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");
    pool.setLabel(id, "Staging");
    const entries = pool.getAllEntries();
    expect(entries[0].label).toBe("Staging");
  });
});
