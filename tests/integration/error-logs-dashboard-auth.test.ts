import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { Hono } from "hono";

let tmpDataDir = "";

const mockConfig = {
  server: {
    proxy_api_key: "secret-key" as string | null,
    trust_proxy: true,
  },
  session: {
    ttl_minutes: 60,
    cleanup_interval_minutes: 5,
  },
  auth: {
    rotation_strategy: "least_used",
  },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
  observability: {
    local_error_log: true,
    max_log_bytes: 10 * 1024 * 1024,
  },
  client: {
    app_version: "0.0.0-test",
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
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return {
    ...actual,
    getDataDir: () => tmpDataDir,
  };
});

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

import { dashboardAuth } from "@src/middleware/dashboard-auth.js";
import {
  createDashboardAuthRoutes,
  _resetRateLimitForTest,
} from "@src/routes/dashboard-login.js";
import { createSettingsRoutes } from "@src/routes/admin/settings.js";
import { createErrorLogRoutes } from "@src/routes/admin/error-logs.js";
import { _resetForTest } from "@src/auth/dashboard-session.js";
import { appendErrorLog } from "@src/logs/error-log.js";

function createProductionOrderedApp(): Hono {
  const app = new Hono();
  app.use("*", dashboardAuth);
  app.route("/", createDashboardAuthRoutes());
  app.route("/", createSettingsRoutes());
  app.route("/", createErrorLogRoutes());
  return app;
}

function extractSessionCookie(setCookie: string | null): string {
  if (!setCookie) {
    throw new Error("login response did not set a cookie");
  }
  const match = setCookie.match(/_codex_session=([^;]+)/);
  if (!match?.[1]) {
    throw new Error(`login response did not include _codex_session: ${setCookie}`);
  }
  return `_codex_session=${match[1]}`;
}

async function loginDashboard(app: Hono): Promise<string> {
  const res = await app.request("/auth/dashboard-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "8.8.8.8",
    },
    body: JSON.stringify({ password: "secret-key" }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

function appendFewErrors(): void {
  appendErrorLog({
    source: "main",
    error: { name: "TypeError", message: "first dashboard error" },
  });
  appendErrorLog({
    source: "server",
    error: { name: "RangeError", message: "second dashboard error" },
  });
}

async function readCount(app: Hono, cookie: string): Promise<{ total: number; unread: number }> {
  const res = await app.request("/admin/error-logs/count", {
    headers: {
      Cookie: cookie,
      "X-Forwarded-For": "8.8.8.8",
    },
  });
  expect(res.status).toBe(200);
  return await res.json() as { total: number; unread: number };
}

describe("dashboard-authenticated error-log admin actions", () => {
  beforeEach(() => {
    tmpDataDir = mkdtempSync(resolve(tmpdir(), "errlog-dashboard-auth-"));
    mockConfig.server.proxy_api_key = "secret-key";
    mockConfig.server.trust_proxy = true;
    mockConfig.observability.local_error_log = true;
    mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
    process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
    _resetForTest();
    _resetRateLimitForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(tmpDataDir)) {
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
    delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
    _resetForTest();
    _resetRateLimitForTest();
    vi.clearAllMocks();
  });

  it("allows cookie-only dashboard sessions to mark all error logs read and delete them", async () => {
    const app = createProductionOrderedApp();
    const cookie = await loginDashboard(app);
    appendFewErrors();

    expect(await readCount(app, cookie)).toEqual({ total: 2, unread: 2 });

    const seenRes = await app.request("/admin/error-logs/seen", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-Forwarded-For": "8.8.8.8",
      },
    });
    expect(seenRes.status).toBe(200);
    expect(await seenRes.json()).toMatchObject({ ok: true });
    expect(await readCount(app, cookie)).toEqual({ total: 2, unread: 0 });

    const deleteRes = await app.request("/admin/error-logs", {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        "X-Forwarded-For": "8.8.8.8",
      },
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });
    expect(await readCount(app, cookie)).toEqual({ total: 0, unread: 0 });
  });

  it("allows cookie-only dashboard sessions to mutate admin settings routes", async () => {
    const app = createProductionOrderedApp();
    const cookie = await loginDashboard(app);

    const res = await app.request("/admin/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Forwarded-For": "8.8.8.8",
      },
      body: JSON.stringify({ proxy_api_key: "secret-key" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, proxy_api_key: "secret-key" });
  });
});
