/**
 * Tests for rotation settings endpoints.
 * GET  /admin/rotation-settings — read current rotation strategy
 * POST /admin/rotation-settings — update rotation strategy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before any imports) ---

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  auth: { rotation_strategy: "least_used" as string },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
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

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

describe("GET /admin/rotation-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.auth.rotation_strategy = "least_used";
  });

  it("returns current rotation strategy", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ rotation_strategy: "least_used" });
  });

  it("reflects config value", async () => {
    mockConfig.auth.rotation_strategy = "sticky";
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings");
    const data = await res.json();
    expect(data.rotation_strategy).toBe("sticky");
  });
});

describe("POST /admin/rotation-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    mockConfig.auth.rotation_strategy = "least_used";
  });

  it("updates strategy to sticky", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "sticky" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("accepts all three valid strategies", async () => {
    const app = createWebRoutes(mockPool);
    for (const strategy of ["least_used", "round_robin", "sticky"]) {
      vi.mocked(mutateYaml).mockClear();
      const res = await app.request("/admin/rotation-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation_strategy: strategy }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects invalid strategy with 400", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "random" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("rejects missing strategy with 400", async () => {
    const app = createWebRoutes(mockPool);
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "my-secret";
    const app = createWebRoutes(mockPool);

    // No auth → 401
    const res1 = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "sticky" }),
    });
    expect(res1.status).toBe(401);

    // With auth → 200
    const res2 = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer my-secret",
      },
      body: JSON.stringify({ rotation_strategy: "sticky" }),
    });
    expect(res2.status).toBe(200);
  });
});
