/**
 * E2E tests for dashboard auth routes.
 *
 * Covers:
 * - POST /auth/dashboard-login  — correct password, wrong password, rate limit, no key
 * - POST /auth/dashboard-logout — clears session cookie
 * - GET  /auth/dashboard-status — required/authenticated states
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config (mutable so tests can change proxy_api_key) ──────

const mockConfig = {
  server: {
    proxy_api_key: "secret123" as string | null,
    trust_proxy: false,
  },
  session: {
    ttl_minutes: 60,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "1.2.3.4" } })),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/codex-e2e-dashboard"),
  getConfigDir: vi.fn(() => "/tmp/codex-e2e-dashboard/config"),
}));

// ── App setup ────────────────────────────────────────────────────

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createDashboardAuthRoutes, _resetRateLimitForTest } from "@src/routes/dashboard-login.js";

const app = new Hono();
app.use("*", requestId);
app.use("*", errorHandler);
app.route("/", createDashboardAuthRoutes());

// ── Helpers ──────────────────────────────────────────────────────

async function login(password: string) {
  return app.request("/auth/dashboard-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

function extractSession(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(/_codex_session=([^;]+)/);
  return match ? match[1] : null;
}

beforeEach(() => {
  _resetRateLimitForTest();
  mockConfig.server.proxy_api_key = "secret123";
  mockConfig.server.trust_proxy = false;
});

// ── GET /auth/dashboard-status ────────────────────────────────────

describe("GET /auth/dashboard-status", () => {
  it("returns required:false when no proxy_api_key configured", async () => {
    mockConfig.server.proxy_api_key = null;

    const res = await app.request("/auth/dashboard-status");
    expect(res.status).toBe(200);
    const body = await res.json() as { required: boolean; authenticated: boolean };
    expect(body.required).toBe(false);
    expect(body.authenticated).toBe(true);
  });

  it("returns required:true, authenticated:false when key set but no session", async () => {
    const res = await app.request("/auth/dashboard-status");
    expect(res.status).toBe(200);
    const body = await res.json() as { required: boolean; authenticated: boolean };
    expect(body.required).toBe(true);
    expect(body.authenticated).toBe(false);
  });

  it("returns authenticated:true with a valid session cookie", async () => {
    const loginRes = await login("secret123");
    const sessionId = extractSession(loginRes.headers.get("set-cookie"));
    expect(sessionId).toBeTruthy();

    const res = await app.request("/auth/dashboard-status", {
      headers: { cookie: `_codex_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });
});

// ── POST /auth/dashboard-login ────────────────────────────────────

describe("POST /auth/dashboard-login", () => {
  it("succeeds with correct password and sets session cookie", async () => {
    const res = await login("secret123");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(res.headers.get("set-cookie")).toMatch(/_codex_session=/);
  });

  it("returns 401 with wrong password", async () => {
    const res = await login("wrong-password");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when no password field", async () => {
    const res = await app.request("/auth/dashboard-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await app.request("/auth/dashboard-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits after 5 consecutive failures", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login("wrong");
      expect(r.status).toBe(401);
    }
    const blocked = await login("secret123");
    expect(blocked.status).toBe(429);
  });

  it("returns 400 when password is empty string (even with no key configured)", async () => {
    mockConfig.server.proxy_api_key = null;
    // Empty string is falsy — validation rejects it before key comparison
    const res = await app.request("/auth/dashboard-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /auth/dashboard-logout ───────────────────────────────────

describe("POST /auth/dashboard-logout", () => {
  it("clears the session cookie", async () => {
    const loginRes = await login("secret123");
    const sessionId = extractSession(loginRes.headers.get("set-cookie"));
    expect(sessionId).toBeTruthy();

    const logoutRes = await app.request("/auth/dashboard-logout", {
      method: "POST",
      headers: { cookie: `_codex_session=${sessionId}` },
    });
    expect(logoutRes.status).toBe(200);
    const body = await logoutRes.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Cleared cookie: Max-Age=0
    expect(logoutRes.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("succeeds even when no session cookie provided", async () => {
    const res = await app.request("/auth/dashboard-logout", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
