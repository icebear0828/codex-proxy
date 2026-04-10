/**
 * Tests for general settings endpoints.
 * GET  /admin/general-settings — read current server/tls config
 * POST /admin/general-settings — update server/tls config
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before any imports) ---

const mockConfig = {
  server: { port: 8080, proxy_api_key: null as string | null },
  tls: { proxy_url: null as string | null, force_http11: false },
  model: { default: "gpt-5.2-codex", default_reasoning_effort: null as string | null, inject_desktop_context: false, suppress_desktop_directives: true },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
  auth: { rotation_strategy: "least_used", refresh_enabled: true, refresh_margin_seconds: 300, refresh_concurrency: 2, max_concurrent_per_account: 3 as number | null, request_interval_ms: 50 as number | null },
  update: { auto_update: true },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("../../paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("../../utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("../../tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

vi.mock("../../fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("../../update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({})),
  checkForUpdate: vi.fn(),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("../../self-update.js", () => ({
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

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

import { createWebRoutes } from "../web.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { reloadAllConfigs } from "../../config.js";

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

const mockUsageStats = {} as unknown as Parameters<typeof createWebRoutes>[1];

function makeApp() {
  return createWebRoutes(mockPool, mockUsageStats);
}

describe("GET /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.port = 8080;
    mockConfig.server.proxy_api_key = null;
    mockConfig.tls.proxy_url = null;
    mockConfig.tls.force_http11 = false;
    mockConfig.model.inject_desktop_context = false;
    mockConfig.model.suppress_desktop_directives = true;
    mockConfig.update.auto_update = true;
  });

  it("returns current values", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      port: 8080,
      proxy_url: null,
      force_http11: false,
      inject_desktop_context: false,
      suppress_desktop_directives: true,
      default_model: "gpt-5.2-codex",
      default_reasoning_effort: null,
      refresh_enabled: true,
      refresh_margin_seconds: 300,
      refresh_concurrency: 2,
      max_concurrent_per_account: 3,
      request_interval_ms: 50,
      auto_update: true,
    });
  });
});

describe("POST /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.port = 8080;
    mockConfig.server.proxy_api_key = null;
    mockConfig.tls.proxy_url = null;
    mockConfig.tls.force_http11 = false;
    mockConfig.model.inject_desktop_context = false;
    mockConfig.model.suppress_desktop_directives = true;
    mockConfig.update.auto_update = true;
  });

  it("changing port sets restart_required: true", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 9090 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("changing proxy_url sets restart_required: false", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy_url: "http://127.0.0.1:7890" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("changing force_http11 sets restart_required: false", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force_http11: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
  });

  it("rejects port out of range", async () => {
    const app = makeApp();

    const res1 = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 0 }),
    });
    expect(res1.status).toBe(400);

    const res2 = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 70000 }),
    });
    expect(res2.status).toBe(400);
  });

  it("rejects invalid proxy_url format", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy_url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("changing inject_desktop_context sets restart_required: false", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inject_desktop_context: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(data.inject_desktop_context).toBe(false); // mockConfig unchanged
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("changing suppress_desktop_directives sets restart_required: false", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suppress_desktop_directives: false }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(data.suppress_desktop_directives).toBe(true); // mockConfig unchanged
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("changing auto_update persists to local.yaml", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_update: false }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("accepts valid max_concurrent_per_account", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrent_per_account: 3 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("accepts null max_concurrent_per_account (reset to default)", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrent_per_account: null }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("rejects invalid max_concurrent_per_account", async () => {
    const app = makeApp();

    for (const bad of [0, -1, 1.5]) {
      const res = await app.request("/admin/general-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_concurrent_per_account: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("accepts valid request_interval_ms", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_interval_ms: 500 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("accepts 0 request_interval_ms (disable)", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_interval_ms: 0 }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects negative request_interval_ms", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_interval_ms: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts null default_reasoning_effort to disable reasoning", async () => {
    mockConfig.model.default_reasoning_effort = "medium";
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_reasoning_effort: null }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("rejects invalid default_reasoning_effort", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_reasoning_effort: "ultra" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "my-secret";
    const app = makeApp();

    // No auth -> 401
    const res1 = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force_http11: true }),
    });
    expect(res1.status).toBe(401);

    // With auth -> 200
    const res2 = await app.request("/admin/general-settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer my-secret",
      },
      body: JSON.stringify({ force_http11: true }),
    });
    expect(res2.status).toBe(200);
  });
});
