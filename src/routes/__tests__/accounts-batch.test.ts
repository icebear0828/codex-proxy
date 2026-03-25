/**
 * Tests for batch account operations.
 * POST /auth/accounts/batch-delete — delete multiple accounts
 * POST /auth/accounts/batch-status — change status for multiple accounts
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

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
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

vi.mock("../../auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
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

function addAccounts(pool: AccountPool, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    // Each token needs a unique first 8 chars to get a unique accountId from the mock
    const unique = `${String.fromCharCode(65 + i)}${String(i).padStart(7, "0")}`;
    ids.push(pool.addAccount(`${unique}-padding-for-length`));
  }
  return ids;
}

describe("batch account operations", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
    mockScheduler.clearOne.mockClear();
  });

  // ── batch-delete ──────────────────────────────────────────

  describe("POST /auth/accounts/batch-delete", () => {
    it("deletes multiple accounts", async () => {
      const ids = addAccounts(pool, 3);
      expect(pool.getAccounts()).toHaveLength(3);

      const res = await app.request("/auth/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(3);
      expect(body.notFound).toHaveLength(0);
      expect(pool.getAccounts()).toHaveLength(0);
      // Scheduler cleared for each
      expect(mockScheduler.clearOne).toHaveBeenCalledTimes(3);
    });

    it("reports not-found ids without failing", async () => {
      const ids = addAccounts(pool, 2);

      const res = await app.request("/auth/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...ids, "nonexistent-id"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(2);
      expect(body.notFound).toEqual(["nonexistent-id"]);
    });

    it("rejects empty ids array", async () => {
      const res = await app.request("/auth/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed body", async () => {
      const res = await app.request("/auth/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: "field" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── batch-status ──────────────────────────────────────────

  describe("POST /auth/accounts/batch-status", () => {
    it("sets multiple accounts to disabled", async () => {
      const ids = addAccounts(pool, 3);

      const res = await app.request("/auth/accounts/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: "disabled" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(3);
      expect(body.notFound).toHaveLength(0);

      for (const acct of pool.getAccounts()) {
        expect(acct.status).toBe("disabled");
      }
    });

    it("sets accounts back to active", async () => {
      const ids = addAccounts(pool, 2);
      // First disable them
      for (const id of ids) pool.markStatus(id, "disabled");

      const res = await app.request("/auth/accounts/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: "active" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(2);
      for (const acct of pool.getAccounts()) {
        expect(acct.status).toBe("active");
      }
    });

    it("rejects disallowed status values", async () => {
      const ids = addAccounts(pool, 1);

      for (const badStatus of ["expired", "banned", "rate_limited", "refreshing"]) {
        const res = await app.request("/auth/accounts/batch-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, status: badStatus }),
        });
        expect(res.status).toBe(400);
      }
    });

    it("reports not-found ids", async () => {
      const ids = addAccounts(pool, 1);

      const res = await app.request("/auth/accounts/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...ids, "ghost"], status: "disabled" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.notFound).toEqual(["ghost"]);
    });

    it("rejects empty ids array", async () => {
      const res = await app.request("/auth/accounts/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [], status: "active" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
