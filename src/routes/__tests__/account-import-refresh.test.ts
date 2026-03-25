/**
 * Tests for refresh-token-only import + label in import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      oauth_client_id: "test-client",
      oauth_token_endpoint: "https://auth.example.com/token",
    },
    server: { proxy_api_key: null },
    upstream: { proxy_url: null },
  })),
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
    chatgpt_user_id: `uid-${token.slice(0, 8)}`,
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

// Mock refreshAccessToken
const mockRefreshAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../../auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: mockRefreshAccessToken,
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { createAccountRoutes } from "../../routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("refresh-token-only import", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
    mockRefreshAccessToken.mockReset();
  });

  afterEach(() => {
    pool.destroy();
    vi.clearAllMocks();
  });

  it("imports account with only refreshToken", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      access_token: "freshAAAA1234567890",
      refresh_token: "new_refresh_abc",
      token_type: "Bearer",
    });

    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ refreshToken: "oaistb_rt_original" }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; failed: number };
    expect(data.added).toBe(1);
    expect(data.failed).toBe(0);
    expect(mockRefreshAccessToken).toHaveBeenCalledWith("oaistb_rt_original", null);

    const entries = pool.getAllEntries();
    expect(entries[0].token).toBe("freshAAAA1234567890");
    expect(entries[0].refreshToken).toBe("new_refresh_abc");
  });

  it("uses token directly when both token and refreshToken provided", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ token: "tokenBBBB1234567890", refreshToken: "rt_both" }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number };
    expect(data.added).toBe(1);
    // Should NOT call refreshAccessToken when token is provided
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();

    const entries = pool.getAllEntries();
    expect(entries[0].token).toBe("tokenBBBB1234567890");
    expect(entries[0].refreshToken).toBe("rt_both");
  });

  it("rejects entry with neither token nor refreshToken", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{}],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("records failure when refresh token exchange fails", async () => {
    mockRefreshAccessToken.mockRejectedValueOnce(new Error("invalid_grant"));

    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ refreshToken: "bad_rt" }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; failed: number; errors: string[] };
    expect(data.added).toBe(0);
    expect(data.failed).toBe(1);
    expect(data.errors[0]).toContain("Refresh token exchange failed");
    expect(data.errors[0]).toContain("invalid_grant");
  });

  it("sets label from import entry", async () => {
    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ token: "tokenCCCC1234567890", label: "Team Alpha" }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number };
    expect(data.added).toBe(1);
    expect(pool.getAccounts()[0].label).toBe("Team Alpha");
  });

  it("handles mixed batch: token-only, RT-only, both", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      access_token: "freshDDDD1234567890",
      refresh_token: "new_rt_d",
      token_type: "Bearer",
    });

    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          { token: "tokenEEEE1234567890" },
          { refreshToken: "rt_only_d" },
          { token: "tokenFFFF1234567890", refreshToken: "rt_both_f", label: "Personal" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { added: number; failed: number };
    expect(data.added).toBe(3);
    expect(data.failed).toBe(0);
    expect(pool.getAccounts()).toHaveLength(3);

    // Verify label was set for the labeled entry
    const labeled = pool.getAccounts().find((a) => a.label === "Personal");
    expect(labeled).toBeDefined();
  });

  it("prefers new refresh token from exchange over original", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      access_token: "freshGGGG1234567890",
      refresh_token: "rotated_rt",
      token_type: "Bearer",
    });

    await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ refreshToken: "original_rt" }],
      }),
    });

    const entries = pool.getAllEntries();
    expect(entries[0].refreshToken).toBe("rotated_rt");
  });

  it("falls back to original RT when exchange returns no new RT", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      access_token: "freshHHHH1234567890",
      token_type: "Bearer",
      // No refresh_token in response
    });

    await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [{ refreshToken: "keep_this_rt" }],
      }),
    });

    const entries = pool.getAllEntries();
    expect(entries[0].refreshToken).toBe("keep_this_rt");
  });
});
