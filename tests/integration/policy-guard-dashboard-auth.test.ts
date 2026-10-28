/**
 * Regression guard for the safety-policy guard admin routes.
 *
 * These routes must accept a cookie-only dashboard session, like every other
 * `/admin/*` route. The failure they guard against is a route adding its own
 * bearer-only check — the pattern that broke cookie sessions for other admin
 * endpoints before the dashboard auth was unified (see the error-logs sibling
 * of this test). `X-Forwarded-For` keeps the request off the localhost
 * auth-bypass so an unauthenticated request really is rejected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: {
    proxy_api_key: "secret-key" as string | null,
    trust_proxy: true,
  },
  session: {
    ttl_minutes: 60,
    cleanup_interval_minutes: 5,
  },
  policy_guard: {
    enabled: false,
    error_codes: ["cyber_policy"],
    message_patterns: ["cybersecurity risk"],
    status_codes: [] as number[],
    ttl_seconds: 3600,
  },
};

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "127.0.0.1" } }));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

import { dashboardAuth } from "@src/middleware/dashboard-auth.js";
import {
  createDashboardAuthRoutes,
  _resetRateLimitForTest,
} from "@src/routes/dashboard-login.js";
import { createPolicyGuardRoutes } from "@src/routes/admin/policy-guard.js";
import { _resetForTest } from "@src/auth/dashboard-session.js";
import {
  recordConversationQuarantine,
  _resetAllConversationQuarantines,
} from "@src/proxy/conversation-quarantine.js";

function createProductionOrderedApp(): Hono {
  const app = new Hono();
  app.use("*", dashboardAuth);
  app.route("/", createDashboardAuthRoutes());
  app.route("/", createPolicyGuardRoutes());
  return app;
}

async function loginDashboard(app: Hono): Promise<string> {
  const res = await app.request("/auth/dashboard-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "8.8.8.8" },
    body: JSON.stringify({ password: "secret-key" }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/_codex_session=([^;]+)/);
  if (!match?.[1]) throw new Error("login did not set a session cookie");
  return `_codex_session=${match[1]}`;
}

function cookieHeaders(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    "X-Forwarded-For": "8.8.8.8",
  };
}

describe("policy-guard admin auth", () => {
  beforeEach(() => {
    mockConfig.server.proxy_api_key = "secret-key";
    _resetForTest();
    _resetRateLimitForTest();
    _resetAllConversationQuarantines();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTest();
    _resetRateLimitForTest();
    _resetAllConversationQuarantines();
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated request", async () => {
    const app = createProductionOrderedApp();
    const res = await app.request("/admin/policy-guard-settings", {
      headers: { "X-Forwarded-For": "8.8.8.8" },
    });
    expect(res.status).toBe(401);
  });

  it("reads settings with a cookie-only dashboard session", async () => {
    const app = createProductionOrderedApp();
    const cookie = await loginDashboard(app);

    const res = await app.request("/admin/policy-guard-settings", {
      headers: cookieHeaders(cookie),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, ttl_seconds: 3600 });
  });

  it("writes settings with a cookie-only dashboard session", async () => {
    const app = createProductionOrderedApp();
    const cookie = await loginDashboard(app);

    const res = await app.request("/admin/policy-guard-settings", {
      method: "POST",
      headers: cookieHeaders(cookie),
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("lists and releases quarantines with a cookie-only dashboard session", async () => {
    const app = createProductionOrderedApp();
    const cookie = await loginDashboard(app);
    recordConversationQuarantine({
      conversationId: "conv-auth",
      input: [],
      code: "cyber_policy",
      message: "blocked",
    });

    const list = await app.request("/admin/policy-guard-quarantines", {
      headers: cookieHeaders(cookie),
    });
    expect(list.status).toBe(200);
    expect((await list.json()).quarantines).toHaveLength(1);

    const reset = await app.request("/admin/policy-guard-quarantines/reset", {
      method: "POST",
      headers: cookieHeaders(cookie),
      body: JSON.stringify({ conversation_id: "conv-auth" }),
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()).released).toBe(1);
  });

  it("still accepts the master API key as a bearer token", async () => {
    const app = createProductionOrderedApp();
    const res = await app.request("/admin/policy-guard-settings", {
      headers: { Authorization: "Bearer secret-key", "X-Forwarded-For": "8.8.8.8" },
    });
    expect(res.status).toBe(200);
  });
});
