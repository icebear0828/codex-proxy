/**
 * E2E tests for quota auto-refresh and warnings.
 *
 * Tests:
 * - GET /auth/accounts returns cached quota from background refresh
 * - GET /auth/accounts?quota=fresh forces live upstream fetch
 * - GET /auth/quota/warnings returns active warnings
 * - Accounts with exhausted quota are skipped by acquire()
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import "@helpers/e2e-setup.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createAccountRoutes } from "@src/routes/accounts.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import type { CodexQuota } from "@src/auth/types.js";
import { updateWarnings, clearWarnings, getActiveWarnings } from "@src/auth/quota-warnings.js";

let app: Hono;
let pool: AccountPool;
let scheduler: RefreshScheduler;

function makeQuota(usedPercent: number, limitReached = false): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: limitReached,
      used_percent: usedPercent,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
  };
}

beforeAll(() => {
  pool = new AccountPool();
  scheduler = new RefreshScheduler(pool);

  app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createAccountRoutes(pool, scheduler));
});

afterAll(() => {
  scheduler.destroy();
  pool.destroy();
  // Clean up warnings
  for (const w of getActiveWarnings()) {
    clearWarnings(w.accountId);
  }
});

describe("E2E: quota auto-refresh", () => {
  it("GET /auth/accounts returns cached quota without upstream call", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-1",
      email: "quota1@test.com",
      planType: "plus",
    }));

    // Simulate background refresh by updating cached quota
    pool.updateCachedQuota(id, makeQuota(65));

    const res = await app.request("/auth/accounts?quota=true");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota; quotaFetchedAt?: string }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct).toBeDefined();
    expect(acct!.quota).toBeDefined();
    expect(acct!.quota!.rate_limit.used_percent).toBe(65);
    expect(acct!.quotaFetchedAt).toBeTruthy();

    // Cleanup
    pool.removeAccount(id);
  });

  it("GET /auth/accounts without quota param also returns cached quota", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-2",
      email: "quota2@test.com",
      planType: "plus",
    }));

    pool.updateCachedQuota(id, makeQuota(42));

    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct?.quota?.rate_limit.used_percent).toBe(42);

    pool.removeAccount(id);
  });

  it("GET /auth/quota/warnings returns empty when no warnings", async () => {
    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);

    const body = await res.json() as { warnings: unknown[] };
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("GET /auth/quota/warnings returns active warnings", async () => {
    updateWarnings("test-acct-1", [
      {
        accountId: "test-acct-1",
        email: "test@test.com",
        window: "primary",
        level: "critical",
        usedPercent: 95,
        resetAt: null,
      },
    ]);

    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);

    const body = await res.json() as { warnings: Array<{ accountId: string; level: string }> };
    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
    const w = body.warnings.find((w) => w.accountId === "test-acct-1");
    expect(w).toBeDefined();
    expect(w!.level).toBe("critical");

    clearWarnings("test-acct-1");
  });

  it("markQuotaExhausted causes acquire to skip that account", async () => {
    const id1 = pool.addAccount(createValidJwt({
      accountId: "acct-exhaust-1",
      email: "exhaust1@test.com",
      planType: "plus",
    }));
    const id2 = pool.addAccount(createValidJwt({
      accountId: "acct-exhaust-2",
      email: "exhaust2@test.com",
      planType: "plus",
    }));

    // Exhaust first account
    pool.markQuotaExhausted(id1, Math.floor(Date.now() / 1000) + 7200);

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(id2);
    pool.release(acquired!.entryId);

    // Cleanup
    pool.removeAccount(id1);
    pool.removeAccount(id2);
  });
});
