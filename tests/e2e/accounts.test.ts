/**
 * E2E tests for account CRUD routes.
 *
 * Covers:
 * - GET  /auth/accounts               — list
 * - POST /auth/accounts               — add (valid token, invalid token)
 * - DELETE /auth/accounts/:id         — remove (found, 404)
 * - POST /auth/accounts/:id/reset-usage
 * - PATCH /auth/accounts/:id/label
 * - GET/POST/DELETE /auth/accounts/:id/cookies
 * - POST /auth/accounts/batch-delete
 * - POST /auth/accounts/batch-status
 * - GET  /auth/accounts/export
 * - GET  /auth/quota/warnings
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import "@helpers/e2e-setup.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createAccountRoutes } from "@src/routes/accounts.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";

let app: Hono;
let pool: AccountPool;
let scheduler: RefreshScheduler;
let cookieJar: CookieJar;

beforeAll(() => {
  pool = new AccountPool();
  scheduler = new RefreshScheduler(pool);
  cookieJar = new CookieJar();

  app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createAccountRoutes(pool, scheduler, cookieJar));
});

afterAll(() => {
  scheduler.destroy();
  pool.destroy();
});

beforeEach(() => {
  // Reset pool between tests
  for (const { id } of pool.getAccounts()) {
    pool.removeAccount(id);
  }
});

// ── GET /auth/accounts ───────────────────────────────────────────

describe("GET /auth/accounts", () => {
  it("returns empty list when no accounts", async () => {
    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: unknown[]; persistence_health: unknown };
    expect(body.accounts).toEqual([]);
    expect(body).toHaveProperty("persistence_health");
  });

  it("returns accounts with id, email, status fields", async () => {
    pool.addAccount(createValidJwt({ accountId: "acct-list-1", email: "list@test.com" }));

    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: Array<{ id: string; email: string; status: string }> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].id).toBeTruthy();
    expect(body.accounts[0].email).toBe("list@test.com");
    expect(body.accounts[0].status).toBe("active");
  });
});

// ── POST /auth/accounts ──────────────────────────────────────────

describe("POST /auth/accounts", () => {
  it("adds a valid JWT token and returns account info", async () => {
    const token = createValidJwt({ accountId: "acct-add-1", email: "add@test.com" });
    const res = await app.request("/auth/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; account: { email: string; status: string } };
    expect(body.success).toBe(true);
    expect(body.account.email).toBe("add@test.com");
    expect(body.account.status).toBe("active");
  });

  it("returns 400 for invalid token", async () => {
    const res = await app.request("/auth/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not.a.valid.jwt" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when neither token nor refreshToken provided", async () => {
    const res = await app.request("/auth/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

// ── DELETE /auth/accounts/:id ────────────────────────────────────

describe("DELETE /auth/accounts/:id", () => {
  it("removes an existing account", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-del-1" }));

    const res = await app.request(`/auth/accounts/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(pool.getAccounts()).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.request("/auth/accounts/nonexistent-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── POST /auth/accounts/:id/reset-usage ──────────────────────────

describe("POST /auth/accounts/:id/reset-usage", () => {
  it("resets usage for existing account", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-reset-1" }));

    const res = await app.request(`/auth/accounts/${id}/reset-usage`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 404 for unknown account", async () => {
    const res = await app.request("/auth/accounts/no-such-id/reset-usage", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /auth/accounts/:id/label ───────────────────────────────

describe("PATCH /auth/accounts/:id/label", () => {
  it("sets a label on an account", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-label-1" }));

    const res = await app.request(`/auth/accounts/${id}/label`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "my-label" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Verify label is persisted via account list
    const listRes = await app.request("/auth/accounts");
    const listBody = await listRes.json() as { accounts: Array<{ id: string; label?: string }> };
    const acct = listBody.accounts.find((a) => a.id === id);
    expect(acct?.label).toBe("my-label");
  });

  it("clears the label when set to null", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-label-2" }));

    await app.request(`/auth/accounts/${id}/label`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "temp" }),
    });

    const res = await app.request(`/auth/accounts/${id}/label`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    const listRes = await app.request("/auth/accounts");
    const listBody = await listRes.json() as { accounts: Array<{ id: string; label?: string | null }> };
    const acct = listBody.accounts.find((a) => a.id === id);
    expect(acct?.label ?? null).toBeNull();
  });
});

// ── Cookie endpoints ──────────────────────────────────────────────

describe("cookie routes", () => {
  it("GET returns null when no cookies set", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-cookie-1" }));

    const res = await app.request(`/auth/accounts/${id}/cookies`);
    expect(res.status).toBe(200);
    const body = await res.json() as { cookies: unknown; hint?: string };
    expect(body.cookies).toBeNull();
    expect(body.hint).toBeTruthy();
  });

  it("POST sets cookies and GET returns them", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-cookie-2" }));

    const setRes = await app.request(`/auth/accounts/${id}/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: "cf_clearance=abc123; __cf_bm=xyz" }),
    });
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json() as { success: boolean; cookies: Record<string, string> };
    expect(setBody.success).toBe(true);
    expect(setBody.cookies).toHaveProperty("cf_clearance");

    const getRes = await app.request(`/auth/accounts/${id}/cookies`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { cookies: Record<string, string> };
    expect(getBody.cookies).toHaveProperty("cf_clearance");
  });

  it("DELETE clears cookies", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-cookie-3" }));
    await app.request(`/auth/accounts/${id}/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: "cf_clearance=abc123" }),
    });

    const delRes = await app.request(`/auth/accounts/${id}/cookies`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { success: boolean };
    expect(delBody.success).toBe(true);

    const getRes = await app.request(`/auth/accounts/${id}/cookies`);
    const getBody = await getRes.json() as { cookies: unknown };
    expect(getBody.cookies).toBeNull();
  });

  it("returns 404 for unknown account on cookie endpoints", async () => {
    const get = await app.request("/auth/accounts/ghost/cookies");
    expect(get.status).toBe(404);

    const post = await app.request("/auth/accounts/ghost/cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies: "cf=x" }),
    });
    expect(post.status).toBe(404);

    const del = await app.request("/auth/accounts/ghost/cookies", { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

// ── Batch operations ──────────────────────────────────────────────

describe("POST /auth/accounts/batch-delete", () => {
  it("deletes multiple accounts by id", async () => {
    const id1 = pool.addAccount(createValidJwt({ accountId: "acct-batch-1a" }));
    const id2 = pool.addAccount(createValidJwt({ accountId: "acct-batch-1b" }));

    const res = await app.request("/auth/accounts/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id1, id2] }),
    });

    expect(res.status).toBe(200);
    expect(pool.getAccounts()).toHaveLength(0);
  });
});

describe("POST /auth/accounts/batch-status", () => {
  it("sets accounts to disabled", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-bstatus-1" }));

    const res = await app.request("/auth/accounts/batch-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], status: "disabled" }),
    });

    expect(res.status).toBe(200);
    const entry = pool.getEntry(id);
    expect(entry?.status).toBe("disabled");
  });

  it("returns 400 for invalid status value", async () => {
    const id = pool.addAccount(createValidJwt({ accountId: "acct-bstatus-2" }));

    const res = await app.request("/auth/accounts/batch-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], status: "invalid-status" }),
    });

    expect(res.status).toBe(400);
  });
});

// ── GET /auth/accounts/export ─────────────────────────────────────

describe("GET /auth/accounts/export", () => {
  it("returns JSON with accounts array", async () => {
    pool.addAccount(createValidJwt({ accountId: "acct-export-1", email: "export@test.com" }));

    const res = await app.request("/auth/accounts/export");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: unknown[] };
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts).toHaveLength(1);
  });

  it("returns empty array when no accounts", async () => {
    const res = await app.request("/auth/accounts/export");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: unknown[] };
    expect(body.accounts).toHaveLength(0);
  });
});

// ── GET /auth/quota/warnings ──────────────────────────────────────

describe("GET /auth/quota/warnings", () => {
  it("returns warnings array and updatedAt", async () => {
    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings: unknown[]; updatedAt: unknown };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body).toHaveProperty("updatedAt");
  });
});
