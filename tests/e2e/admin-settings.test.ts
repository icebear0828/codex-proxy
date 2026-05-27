/**
 * E2E tests for admin settings routes.
 *
 * Covers full HTTP pipeline (routing, middleware, auth gating, response shape):
 * - GET/POST /admin/rotation-settings
 * - GET/POST /admin/settings
 * - GET/POST /admin/general-settings
 * - GET/POST /admin/quota-settings
 *
 * Self-contained mocks — no transport required (no upstream calls).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mutable mock config ───────────────────────────────────────────

const mockConfig = {
  server: {
    port: 8080,
    proxy_api_key: null as string | null,
    trust_proxy: false,
  },
  tls: {
    proxy_url: null as string | null,
    force_http11: false,
  },
  model: {
    default: "gpt-5.4",
    default_reasoning_effort: null as string | null,
    inject_desktop_context: false,
    suppress_desktop_directives: true,
    aliases: {} as Record<string, string>,
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
  usage_stats: { history_retention_days: null as number | null, credits_per_usd: 25 },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  getLocalConfigPath: vi.fn(() => "/tmp/codex-e2e-settings/local.yaml"),
  reloadAllConfigs: vi.fn(),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@src/logs/store.js", () => ({
  logStore: { setState: vi.fn() },
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/codex-e2e-settings"),
  getConfigDir: vi.fn(() => "/tmp/codex-e2e-settings/config"),
}));

// ── App setup ────────────────────────────────────────────────────

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createSettingsRoutes } from "@src/routes/admin/settings.js";

const app = new Hono();
app.use("*", requestId);
app.use("*", errorHandler);
app.route("/", createSettingsRoutes());

beforeEach(() => {
  mockConfig.server.proxy_api_key = null;
});

// ── Rotation settings ─────────────────────────────────────────────

describe("GET /admin/rotation-settings", () => {
  it("returns current rotation strategy", async () => {
    const res = await app.request("/admin/rotation-settings");
    expect(res.status).toBe(200);
    const body = await res.json() as { rotation_strategy: string };
    expect(body.rotation_strategy).toBe("least_used");
  });
});

describe("POST /admin/rotation-settings", () => {
  it("accepts valid strategy when no API key configured", async () => {
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "round_robin" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 401 when API key required but missing from request", async () => {
    mockConfig.server.proxy_api_key = "adminkey";

    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "sticky" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts request with correct API key in Authorization header", async () => {
    mockConfig.server.proxy_api_key = "adminkey";

    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer adminkey",
      },
      body: JSON.stringify({ rotation_strategy: "sticky" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid strategy value", async () => {
    const res = await app.request("/admin/rotation-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotation_strategy: "unknown-strategy" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Proxy API key settings ────────────────────────────────────────

describe("GET /admin/settings", () => {
  it("returns proxy_api_key (null when not set)", async () => {
    const res = await app.request("/admin/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as { proxy_api_key: string | null };
    expect(body).toHaveProperty("proxy_api_key");
    expect(body.proxy_api_key).toBeNull();
  });
});

describe("POST /admin/settings", () => {
  it("sets a new proxy_api_key when none currently configured", async () => {
    const res = await app.request("/admin/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxy_api_key: "new-secret" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 401 when changing key without current key in header", async () => {
    mockConfig.server.proxy_api_key = "existing-key";

    const res = await app.request("/admin/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxy_api_key: "new-key" }),
    });
    expect(res.status).toBe(401);
  });
});

// ── General settings ──────────────────────────────────────────────

describe("GET /admin/general-settings", () => {
  it("returns all expected fields", async () => {
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("port");
    expect(body).toHaveProperty("refresh_enabled");
    expect(body).toHaveProperty("default_reasoning_effort");
    expect(body).toHaveProperty("max_concurrent_per_account");
    expect(body).toHaveProperty("logs_enabled");
    expect(body).toHaveProperty("auto_update");
    expect(body).toHaveProperty("model_aliases");
  });
});

describe("POST /admin/general-settings", () => {
  it("accepts valid settings update", async () => {
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs_enabled: true, refresh_enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 401 when API key required but not provided", async () => {
    mockConfig.server.proxy_api_key = "admin123";

    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs_enabled: true }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Quota settings ────────────────────────────────────────────────

describe("GET /admin/quota-settings", () => {
  it("returns refresh_interval_minutes, warning_thresholds, skip_exhausted", async () => {
    const res = await app.request("/admin/quota-settings");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      refresh_interval_minutes: number;
      warning_thresholds: { primary: number[]; secondary: number[] };
      skip_exhausted: boolean;
    };
    expect(body.refresh_interval_minutes).toBe(5);
    expect(Array.isArray(body.warning_thresholds.primary)).toBe(true);
    expect(typeof body.skip_exhausted).toBe("boolean");
  });
});

describe("POST /admin/quota-settings", () => {
  it("accepts valid quota update", async () => {
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_interval_minutes: 10, skip_exhausted: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("returns 400 for negative refresh_interval_minutes", async () => {
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_interval_minutes: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for out-of-range warning thresholds", async () => {
    const res = await app.request("/admin/quota-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warning_thresholds: { primary: [150] } }),
    });
    expect(res.status).toBe(400);
  });
});
