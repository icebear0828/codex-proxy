/**
 * Tests for account import/export endpoints.
 * GET  /auth/accounts/export — export all accounts with tokens
 * POST /auth/accounts/import — bulk import accounts from tokens
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing anything
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
  })),
}));

// Mock JWT utilities — all tokens are "valid" by default
const mockIsTokenExpired = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: mockIsTokenExpired,
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("../../auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { createAccountRoutes } from "../../routes/accounts.js";

// Minimal RefreshScheduler stub
const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("account import/export", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    mockIsTokenExpired.mockReturnValue(false);
    pool = new AccountPool();
    const routes = createAccountRoutes(
      pool,
      mockScheduler as never,
    );
    app = new Hono();
    app.route("/", routes);
  });

  afterEach(() => {
    pool.destroy();
    vi.clearAllMocks();
  });

  // ── Export ──────────────────────────────────────────────

  it("GET /auth/accounts/export returns empty array when no accounts", async () => {
    const res = await app.request("/auth/accounts/export");
    expect(res.status).toBe(200);
    const data = await res.json() as { accounts: unknown[] };
    expect(data.accounts).toEqual([]);
  });

  it("GET /auth/accounts/export returns full entries with tokens", async () => {
    pool.addAccount("tokenAAAA1234567890");
    pool.addAccount("tokenBBBB1234567890");

    const res = await app.request("/auth/accounts/export");
    expect(res.status).toBe(200);
    const data = await res.json() as { accounts: Array<{ token: string; email: string | null; id: string }> };
    expect(data.accounts).toHaveLength(2);

    // Must include sensitive fields (token, refreshToken)
    for (const acct of data.accounts) {
      expect(acct.token).toBeTruthy();
      expect(acct.id).toBeTruthy();
    }
  });

  it("GET /auth/accounts/export?format=minimal returns only refreshToken + label", async () => {
    const id1 = pool.addAccount("tokenAAAA1234567890");
    // Manually set refreshToken and label
    const entry = pool.getEntry(id1);
    if (entry) {
      entry.refreshToken = "rt_test_abc";
    }
    pool.setLabel(id1, "My Team");

    // Add another account without refreshToken
    const id2 = pool.addAccount("tokenBBBB1234567890");
    const entry2 = pool.getEntry(id2);
    if (entry2) {
      entry2.refreshToken = null;
    }

    const res = await app.request("/auth/accounts/export?format=minimal");
    expect(res.status).toBe(200);
    const data = await res.json() as { accounts: Array<Record<string, unknown>> };
    // Only accounts with refreshToken are included
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].refreshToken).toBe("rt_test_abc");
    expect(data.accounts[0].label).toBe("My Team");
    // Should NOT contain token, id, email, etc.
    expect(data.accounts[0]).not.toHaveProperty("token");
    expect(data.accounts[0]).not.toHaveProperty("id");
    expect(data.accounts[0]).not.toHaveProperty("email");
  });

  it("GET /auth/accounts/export?ids= filters server-side", async () => {
    const id1 = pool.addAccount("tokenAAAA1234567890");
    pool.addAccount("tokenBBBB1234567890");

    const res = await app.request(`/auth/accounts/export?ids=${id1}`);
    expect(res.status).toBe(200);
    const data = await res.json() as { accounts: Array<{ id: string }> };
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].id).toBe(id1);
  });

  // ── Import ─────────────────────────────────────────────

  it("POST /auth/accounts/import adds new accounts", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          { token: "tokenCCCC1234567890" },
          { token: "tokenDDDD1234567890" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; updated: number; failed: number };
    expect(data.added).toBe(2);
    expect(data.updated).toBe(0);
    expect(data.failed).toBe(0);

    // Verify accounts are in the pool
    expect(pool.getAccounts()).toHaveLength(2);
    // Verify scheduler was called for each
    expect(mockScheduler.scheduleOne).toHaveBeenCalledTimes(2);
  });

  it("POST /auth/accounts/import detects duplicates as updates", async () => {
    // Pre-add an account
    pool.addAccount("tokenEEEE1234567890");
    expect(pool.getAccounts()).toHaveLength(1);

    // Import same token again + one new
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          { token: "tokenEEEE1234567890" },
          { token: "tokenFFFF1234567890" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; updated: number; failed: number };
    expect(data.added).toBe(1);
    expect(data.updated).toBe(1);
    expect(data.failed).toBe(0);

    // Pool should have 2 total (not 3)
    expect(pool.getAccounts()).toHaveLength(2);
  });

  it("POST /auth/accounts/import handles invalid tokens", async () => {
    // Make isTokenExpired return true for specific tokens
    mockIsTokenExpired.mockImplementation(
      ((...args: unknown[]) => args[0] === "expiredToken12345678") as () => boolean,
    );

    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          { token: "validToken123456789" },
          { token: "expiredToken12345678" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; failed: number; errors: string[] };
    expect(data.added).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toContain("expired");
  });

  it("POST /auth/accounts/import with refreshToken", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          { token: "tokenGGGG1234567890", refreshToken: "refresh_abc" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number };
    expect(data.added).toBe(1);

    // Verify refreshToken was passed
    const entries = pool.getAllEntries();
    expect(entries[0].refreshToken).toBe("refresh_abc");
  });

  it("POST /auth/accounts/import rejects empty accounts array", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("POST /auth/accounts/import rejects invalid body", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    expect(res.status).toBe(400);
  });

  // ── Round-trip ─────────────────────────────────────────

  it("export → import round-trip preserves accounts", async () => {
    pool.addAccount("tokenHHHH1234567890");
    pool.addAccount("tokenIIII1234567890");

    // Export
    const exportRes = await app.request("/auth/accounts/export");
    const exported = await exportRes.json() as { accounts: Array<{ token: string; refreshToken?: string | null }> };
    expect(exported.accounts).toHaveLength(2);

    // Create a fresh pool + app
    const pool2 = new AccountPool();
    const routes2 = createAccountRoutes(pool2, mockScheduler as never);
    const app2 = new Hono();
    app2.route("/", routes2);

    // Import the exported data (only token + refreshToken needed)
    const importBody = {
      accounts: exported.accounts.map((a) => ({
        token: a.token,
        refreshToken: a.refreshToken,
      })),
    };

    const importRes = await app2.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(importBody),
    });

    expect(importRes.status).toBe(200);
    const result = await importRes.json() as { added: number };
    expect(result.added).toBe(2);
    expect(pool2.getAccounts()).toHaveLength(2);

    pool2.destroy();
  });
});
