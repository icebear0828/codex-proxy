/**
 * Tests for account label API.
 * PATCH /auth/accounts/:id/label — set/clear label
 * GET /auth/accounts — verify label in response
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
    },
    server: { proxy_api_key: null },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "team",
    chatgpt_user_id: `uid-${token.slice(0, 8)}`,
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

vi.mock("@src/auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { Hono } from "hono";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("account label API", () => {
  let pool: AccountPool;
  let app: Hono;
  let accountId: string;

  beforeEach(() => {
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
    accountId = pool.addAccount("testtoken-padding-for-length");
  });

  it("PATCH sets label and returns 200", async () => {
    const res = await app.request(`/auth/accounts/${accountId}/label`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Team Alpha" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(pool.getAccounts()[0].label).toBe("Team Alpha");
  });

  it("PATCH with null clears label", async () => {
    pool.setLabel(accountId, "Old Label");
    const res = await app.request(`/auth/accounts/${accountId}/label`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: null }),
    });
    expect(res.status).toBe(200);
    expect(pool.getAccounts()[0].label).toBeNull();
  });

  it("PATCH with >64 chars returns 400", async () => {
    const longLabel = "x".repeat(65);
    const res = await app.request(`/auth/accounts/${accountId}/label`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: longLabel }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH on nonexistent account returns 404", async () => {
    const res = await app.request("/auth/accounts/nonexistent/label", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /auth/accounts includes label", async () => {
    pool.setLabel(accountId, "Production");
    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts[0].label).toBe("Production");
  });
});
