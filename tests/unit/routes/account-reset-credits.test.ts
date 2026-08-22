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
    api: { base_url: "https://chatgpt.com/backend-api" },
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

const mockGetResetCredits = vi.fn();
const mockConsumeResetCredit = vi.fn();
const mockGetUsage = vi.fn();

vi.mock("@src/proxy/codex-api.js", () => {
  return {
    CodexApi: class {
      getResetCredits = mockGetResetCredits;
      consumeResetCredit = mockConsumeResetCredit;
      getUsage = mockGetUsage;
    },
    CodexApiError: class extends Error {
      constructor(public status: number, public body: string) {
        super(`Codex API error: ${status}`);
      }
    },
  };
});

import { Hono } from "hono";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("Account reset credits routes", () => {
  let pool: AccountPool;
  let app: Hono;
  let accountId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);

    accountId = pool.addAccount("ey-token-12345678");
  });

  describe("GET /auth/accounts/:id/reset-credits", () => {
    it("returns 404 if account does not exist", async () => {
      const res = await app.request("/auth/accounts/nonexistent/reset-credits");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Account not found");
    });

    it("returns 409 if account is not active", async () => {
      pool.markStatus(accountId, "disabled");
      const res = await app.request(`/auth/accounts/${accountId}/reset-credits`);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("disabled");
    });

    it("returns reset credits snapshot on success", async () => {
      mockGetResetCredits.mockResolvedValueOnce({
        available_count: 2,
        credits: [{ id: "c1", status: "available" }],
        next_expires_at: 1789000000,
      });

      const res = await app.request(`/auth/accounts/${accountId}/reset-credits`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.available_count).toBe(2);
      expect(json.credits).toHaveLength(1);
    });

    it("returns 502 when upstream call fails", async () => {
      mockGetResetCredits.mockRejectedValueOnce(new Error("Network failure"));
      const res = await app.request(`/auth/accounts/${accountId}/reset-credits`);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe("Failed to fetch reset credits from Codex API");
    });
  });

  describe("POST /auth/accounts/:id/reset-credits/consume", () => {
    it("returns 404 if account does not exist", async () => {
      const res = await app.request("/auth/accounts/nonexistent/reset-credits/consume", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 if account is not active", async () => {
      pool.markStatus(accountId, "disabled");
      const res = await app.request(`/auth/accounts/${accountId}/reset-credits/consume`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
    });

    it("consumes reset credit and refreshes quota on success", async () => {
      mockConsumeResetCredit.mockResolvedValueOnce(undefined);
      mockGetUsage.mockResolvedValueOnce({
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 0,
            reset_at: 1789000000,
            limit_window_seconds: 18000,
            reset_after_seconds: 18000,
          },
          secondary_window: null,
        },
        code_review_rate_limit: null,
        rate_limit_reset_credits: {
          available_count: 1,
        },
      });

      const res = await app.request(`/auth/accounts/${accountId}/reset-credits/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redeem_request_id: "test-req-id" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.quota.rate_limit.used_percent).toBe(0);
      expect(json.quota.reset_credits_available).toBe(1);

      // Verify cached quota was updated in pool
      const entry = pool.getEntry(accountId);
      expect(entry?.cachedQuota?.rate_limit.used_percent).toBe(0);
      expect(entry?.cachedQuota?.reset_credits_available).toBe(1);
    });

    it("returns 502 when consume call fails", async () => {
      mockConsumeResetCredit.mockRejectedValueOnce(new Error("No credits left"));
      const res = await app.request(`/auth/accounts/${accountId}/reset-credits/consume`, {
        method: "POST",
      });
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe("Failed to consume reset credit from Codex API");
    });
  });
});
