/**
 * E2E tests for auth routes (/auth/status, /auth/token, /auth/logout).
 *
 * Excludes OAuth login/callback/device-code (external provider dependency)
 * and import-cli (real filesystem dependency).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import "@helpers/e2e-setup.js";
import { createValidJwt, createExpiredJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createAuthRoutes } from "@src/routes/auth.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";

let app: Hono;
let pool: AccountPool;
let scheduler: RefreshScheduler;

beforeAll(() => {
  pool = new AccountPool();
  scheduler = new RefreshScheduler(pool);

  app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createAuthRoutes(pool, scheduler));
});

afterAll(() => {
  scheduler.destroy();
  pool.destroy();
});

beforeEach(() => {
  pool.clearToken();
});

// ── GET /auth/status ─────────────────────────────────────────────

describe("GET /auth/status", () => {
  it("returns authenticated:false when pool is empty", async () => {
    const res = await app.request("/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authenticated: boolean;
      user: unknown;
      pool: { total: number };
    };
    expect(body.authenticated).toBe(false);
    expect(body.user).toBeNull();
    expect(body.pool.total).toBe(0);
  });

  it("returns authenticated:true with user info when accounts exist", async () => {
    const token = createValidJwt({
      accountId: "acct-status-1",
      email: "status@test.com",
      planType: "plus",
    });
    pool.addAccount(token);

    const res = await app.request("/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authenticated: boolean;
      user: { email: string; planType: string } | null;
      pool: { total: number; active: number };
    };
    expect(body.authenticated).toBe(true);
    expect(body.user).not.toBeNull();
    expect(body.user!.email).toBe("status@test.com");
    expect(body.pool.active).toBe(1);
  });

  it("includes pool summary fields", async () => {
    const token = createValidJwt({ accountId: "acct-status-2", email: "s2@test.com" });
    pool.addAccount(token);

    const res = await app.request("/auth/status");
    const body = await res.json() as {
      pool: { total: number; active: number; expired: number; rate_limited: number };
    };
    expect(body.pool).toHaveProperty("total");
    expect(body.pool).toHaveProperty("active");
    expect(body.pool).toHaveProperty("expired");
    expect(body.pool).toHaveProperty("rate_limited");
  });
});

// ── POST /auth/token ────────────────────────────────────────────

describe("POST /auth/token", () => {
  it("adds a valid token", async () => {
    const token = createValidJwt({ accountId: "acct-token-1", email: "tok@test.com" });
    const res = await app.request("/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Verify account was added
    expect(pool.isAuthenticated()).toBe(true);
  });

  it("rejects empty token with 400", async () => {
    const res = await app.request("/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects expired token with 400", async () => {
    const token = createExpiredJwt();
    const res = await app.request("/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("expired");
  });
});

// ── POST /auth/logout ───────────────────────────────────────────

describe("POST /auth/logout", () => {
  it("clears all accounts", async () => {
    const token1 = createValidJwt({ accountId: "acct-logout-1", email: "l1@test.com" });
    const token2 = createValidJwt({ accountId: "acct-logout-2", email: "l2@test.com" });
    pool.addAccount(token1);
    pool.addAccount(token2);
    expect(pool.isAuthenticated()).toBe(true);

    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    expect(pool.isAuthenticated()).toBe(false);
    expect(pool.getPoolSummary().total).toBe(0);
  });
});
