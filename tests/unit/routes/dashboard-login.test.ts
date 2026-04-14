import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: { proxy_api_key: "secret-key" as string | null, trust_proxy: false },
  session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
  auth: { rotation_strategy: "least_used" as string },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "192.168.1.100" } }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

vi.mock("@src/auth/dashboard-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/auth/dashboard-session.js")>();
  return actual;
});

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("@src/update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({})),
  checkForUpdate: vi.fn(),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/self-update.js", () => ({
  getProxyInfo: vi.fn(() => ({})),
  canSelfUpdate: vi.fn(() => false),
  checkProxySelfUpdate: vi.fn(),
  applyProxySelfUpdate: vi.fn(),
  isProxyUpdateInProgress: vi.fn(() => false),
  getCachedProxyUpdateResult: vi.fn(() => null),
  getDeployMode: vi.fn(() => "git"),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => vi.fn()),
}));

import {
  createDashboardAuthRoutes,
  _resetRateLimitForTest,
} from "@src/routes/dashboard-login.js";
import { createSettingsRoutes } from "@src/routes/admin/settings.js";
import { _resetForTest } from "@src/auth/dashboard-session.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", createDashboardAuthRoutes());
  app.route("/", createSettingsRoutes());
  return app;
}

describe("dashboard auth endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = "secret-key";
    mockConfig.server.trust_proxy = false;
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.100" } });
    _resetForTest();
    _resetRateLimitForTest();
  });

  describe("POST /auth/dashboard-login", () => {
    it("returns 200 and sets cookie with correct password", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-key" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("_codex_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=");
    });

    it("returns 401 with wrong password", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("returns 400 with missing body", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("sets Secure flag when behind HTTPS reverse proxy", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ password: "secret-key" }),
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("Secure");
    });

    it("omits Secure flag for HTTP", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-key" }),
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie");
      expect(cookie).not.toContain("Secure");
    });

    it("returns 429 after 5 failed attempts", async () => {
      const app = createApp();
      for (let i = 0; i < 5; i++) {
        await app.request("/auth/dashboard-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "wrong" }),
        });
      }
      const res = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(res.status).toBe(429);
    });
  });

  describe("POST /auth/dashboard-logout", () => {
    it("clears session and cookie", async () => {
      const app = createApp();
      // Login first
      const loginRes = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-key" }),
      });
      const cookie = loginRes.headers.get("set-cookie")!;
      const sessionId = cookie.match(/_codex_session=([^;]+)/)![1];

      // Logout
      const logoutRes = await app.request("/auth/dashboard-logout", {
        method: "POST",
        headers: { Cookie: `_codex_session=${sessionId}` },
      });
      expect(logoutRes.status).toBe(200);
      const body = await logoutRes.json();
      expect(body.success).toBe(true);

      const clearCookie = logoutRes.headers.get("set-cookie");
      expect(clearCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /auth/dashboard-status", () => {
    it("returns required=false when no key configured", async () => {
      mockConfig.server.proxy_api_key = null;
      const app = createApp();
      const res = await app.request("/auth/dashboard-status");
      const body = await res.json();
      expect(body.required).toBe(false);
      expect(body.authenticated).toBe(true);
    });

    it("returns required=false for localhost", async () => {
      mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
      const app = createApp();
      const res = await app.request("/auth/dashboard-status");
      const body = await res.json();
      expect(body.required).toBe(false);
      expect(body.authenticated).toBe(true);
    });

    it("returns required=true, authenticated=false for remote without session", async () => {
      const app = createApp();
      const res = await app.request("/auth/dashboard-status");
      const body = await res.json();
      expect(body.required).toBe(true);
      expect(body.authenticated).toBe(false);
    });

    it("returns required=true when trust_proxy=true and X-Forwarded-For reveals remote IP from localhost socket", async () => {
      mockConfig.server.trust_proxy = true;
      mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
      const app = createApp();
      const res = await app.request("/auth/dashboard-status", {
        headers: { "X-Forwarded-For": "8.8.8.8" },
      });
      const body = await res.json();
      expect(body.required).toBe(true);
      expect(body.authenticated).toBe(false);
    });

    it("returns required=false when trust_proxy=true but no XFF (direct localhost)", async () => {
      mockConfig.server.trust_proxy = true;
      mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
      const app = createApp();
      const res = await app.request("/auth/dashboard-status");
      const body = await res.json();
      expect(body.required).toBe(false);
      expect(body.authenticated).toBe(true);
    });

    it("returns required=true, authenticated=true for remote with valid session", async () => {
      const app = createApp();
      // Login first
      const loginRes = await app.request("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-key" }),
      });
      const cookie = loginRes.headers.get("set-cookie")!;
      const sessionId = cookie.match(/_codex_session=([^;]+)/)![1];

      const statusRes = await app.request("/auth/dashboard-status", {
        headers: { Cookie: `_codex_session=${sessionId}` },
      });
      const body = await statusRes.json();
      expect(body.required).toBe(true);
      expect(body.authenticated).toBe(true);
    });
  });

  describe("POST /admin/settings — remote clear protection", () => {
    it("blocks remote session from clearing proxy_api_key", async () => {
      const app = createApp();
      const res = await app.request("/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-key",
        },
        body: JSON.stringify({ proxy_api_key: null }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Cannot clear");
    });

    it("allows localhost to clear proxy_api_key", async () => {
      mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
      const app = createApp();
      const res = await app.request("/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-key",
        },
        body: JSON.stringify({ proxy_api_key: null }),
      });
      expect(res.status).toBe(200);
    });

    it("allows remote session to change (not clear) proxy_api_key", async () => {
      const app = createApp();
      const res = await app.request("/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-key",
        },
        body: JSON.stringify({ proxy_api_key: "new-key" }),
      });
      expect(res.status).toBe(200);
    });
  });
});
