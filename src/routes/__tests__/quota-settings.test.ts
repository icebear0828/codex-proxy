/**
 * Tests for quota settings endpoints.
 * GET  /admin/quota-settings — read current quota config
 * POST /admin/quota-settings — update quota config
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before any imports) ---

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
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

vi.mock("../../tls/curl-binary.js", () => ({
  getCurlDiagnostics: vi.fn(() => ({})),
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

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

describe("GET /admin/quota-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.quota = {
      refresh_interval_minutes: 5,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    };
  });

  it("returns current quota config", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      refresh_interval_minutes: 5,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    });
  });
});

describe("POST /admin/quota-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    mockConfig.quota = {
      refresh_interval_minutes: 5,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    };
  });

  it("updates refresh interval", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_interval_minutes: 10 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("updates warning thresholds", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        warning_thresholds: { primary: [70, 85, 95], secondary: [60] },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("validates refresh_interval_minutes >= 1", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_interval_minutes: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("validates thresholds 1-100", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        warning_thresholds: { primary: [101] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "my-secret";
    const app = createWebRoutes(mockPool);

    // No auth → 401
    const res1 = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_interval_minutes: 10 }),
    });
    expect(res1.status).toBe(401);

    // With auth → 200
    const res2 = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer my-secret",
      },
      body: JSON.stringify({ refresh_interval_minutes: 10 }),
    });
    expect(res2.status).toBe(200);
  });

  it("updates skip_exhausted", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip_exhausted: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});
