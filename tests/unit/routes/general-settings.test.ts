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
    aliases: {} as Record<string, string>,
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
  update: { auto_update: true, auto_download: false, show_update_dialog: false },
  logs: { enabled: false, capacity: 2000, capture_body: false, llm_only: true },
  usage_stats: {
    history_retention_days: null as number | null,
    credits_per_usd: 25,
  },
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
    mockConfig.usage_stats.history_retention_days = null;
    mockConfig.usage_stats.credits_per_usd = 25;
  });

  it("returns current values including logs_llm_only and credits_per_usd", async () => {
    mockConfig.usage_stats.credits_per_usd = 40;
    const app = makeApp();
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      port: 8080,
      proxy_url: null,
      force_http11: false,
      default_model: "gpt-5.4",
      model_aliases: {},
      refresh_enabled: true,
      auto_update: true,
      auto_download: false,
      show_update_dialog: false,
      logs_enabled: false,
      logs_capacity: 2000,
      logs_capture_body: false,
      logs_llm_only: true,
      usage_history_retention_days: null,
      credits_per_usd: 40,
    });
  });
});

describe("POST /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.logs.llm_only = true;
    mockConfig.usage_stats.history_retention_days = null;
    mockConfig.usage_stats.credits_per_usd = 25;
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

  it("persists show_update_dialog without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_update_dialog: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      update: { show_update_dialog: true },
    });
  });

  it("persists custom model aliases into local model aliases", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_aliases: {
          "sonnet-local": "gpt-5.4",
          "openai-fast": "openai:gpt-4o",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: {
        aliases: {
          "sonnet-local": "gpt-5.4",
          "openai-fast": "openai:gpt-4o",
        },
      },
    });
  });

  it("rejects empty custom model alias names", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_aliases: { "  ": "gpt-5.4" } }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("model_aliases");
  });

  it("persists finite usage history retention without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: 30 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { history_retention_days: 30 },
    });
  });

  it("persists unlimited usage history retention as null", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: null }),
    });

    expect(res.status).toBe(200);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { history_retention_days: null },
    });
  });

  it("persists dashboard credit USD conversion rate without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits_per_usd: 40 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { credits_per_usd: 40 },
    });
  });

  it("rejects invalid dashboard credit USD conversion rate", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits_per_usd: -1 }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("credits_per_usd");
  });

  it("rejects invalid usage history retention", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: 0 }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("usage_history_retention_days");
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
