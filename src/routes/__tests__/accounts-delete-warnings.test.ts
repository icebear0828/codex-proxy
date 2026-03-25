/**
 * Tests that deleting an account also clears its quota warnings.
 * Regression test for issue #100.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { updateWarnings, getActiveWarnings, clearWarnings } from "../../auth/quota-warnings.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("DELETE /auth/accounts/:id clears quota warnings", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    mockIsTokenExpired.mockReturnValue(false);
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);

    // Clean up warnings state between tests
    for (const w of getActiveWarnings()) {
      clearWarnings(w.accountId);
    }
  });

  it("should clear quota warnings when an account is deleted", async () => {
    // Add an account
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-delete-warnings";
    const addResp = await app.request("/auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(addResp.status).toBe(200);
    const { account } = await addResp.json();
    const accountId = account.id;

    // Simulate quota warnings for this account
    updateWarnings(accountId, [
      {
        accountId,
        email: "test@test.com",
        window: "primary",
        level: "critical",
        usedPercent: 95,
        resetAt: null,
      },
    ]);
    expect(getActiveWarnings().some((w) => w.accountId === accountId)).toBe(true);

    // Delete the account
    const delResp = await app.request(`/auth/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
    expect(delResp.status).toBe(200);

    // Warnings should be cleared
    expect(getActiveWarnings().some((w) => w.accountId === accountId)).toBe(false);
  });

  it("should not fail when deleting account with no warnings", async () => {
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-no-warnings";
    const addResp = await app.request("/auth/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { account } = await addResp.json();

    // No warnings set — delete should still succeed
    const delResp = await app.request(`/auth/accounts/${encodeURIComponent(account.id)}`, {
      method: "DELETE",
    });
    expect(delResp.status).toBe(200);
    const body = await delResp.json();
    expect(body.success).toBe(true);
  });
});
