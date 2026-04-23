/**
 * Tests for general settings endpoints.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = {
  server: { port: 8080, proxy_api_key: null as string | null },
  tls: { proxy_url: null as string | null, force_http11: false },
  model: {
    default: "gpt-5.4",
    default_reasoning_effort: null as string | null,
    inject_desktop_context: false,
    suppress_desktop_directives: true,
  },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
  auth: {
    rotation_strategy: "least_used",
    refresh_enabled: true,
    refresh_margin_seconds: 300,
    refresh_concurrency: 2,
    max_concurrent_per_account: 3 as number | null,
    request_interval_ms: 50 as number | null,
  },
  update: { auto_update: true, auto_download: false },
  logs: { enabled: false, capacity: 2000, capture_body: false, llm_only: true },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

const mockLogStore = vi.hoisted(() => ({
  setState: vi.fn(),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@src/logs/store.js", () => ({
  logStore: mockLogStore,
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

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

import { createWebRoutes } from "@src/routes/web.js";
import { mutateYaml } from "@src/utils/yaml-mutate.js";
import { reloadAllConfigs } from "@src/config.js";

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
    mockConfig.logs.llm_only = true;
  });

  it("returns current values including logs_llm_only", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      port: 8080,
      proxy_url: null,
      force_http11: false,
      default_model: "gpt-5.4",
      refresh_enabled: true,
      auto_update: true,
      auto_download: false,
      logs_enabled: false,
      logs_capacity: 2000,
      logs_capture_body: false,
      logs_llm_only: true,
    });
  });
});

describe("POST /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.logs.llm_only = true;
  });

  it("persists logs_llm_only without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs_llm_only: false }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("syncs log store when logs_enabled changes", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs_enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(mockLogStore.setState).toHaveBeenCalledWith({ enabled: true });
  });
});
