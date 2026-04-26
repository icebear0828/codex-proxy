import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({
  config: {
    server: { proxy_api_key: null as string | null },
    ollama: {
      enabled: false,
      host: "127.0.0.1",
      port: 11434,
      version: "0.18.3",
      disable_vision: false,
    },
  },
  restartError: null as string | null,
}));

const mockConfig = vi.hoisted(() => ({
  getConfig: vi.fn(() => state.config),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  reloadAllConfigs: vi.fn(),
}));

const mockYaml = vi.hoisted(() => ({
  mutateYaml: vi.fn((_path: string, mutator: (data: Record<string, unknown>) => void) => {
    const data = {
      ollama: { ...state.config.ollama },
    };
    mutator(data);
    state.config.ollama = {
      ...state.config.ollama,
      ...(data.ollama as Record<string, unknown>),
    };
  }),
}));

const mockOllamaServer = vi.hoisted(() => ({
  getOllamaBridgeStatusForConfig: vi.fn(),
  restartOllamaBridge: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: mockConfig.getConfig,
  getLocalConfigPath: mockConfig.getLocalConfigPath,
  reloadAllConfigs: mockConfig.reloadAllConfigs,
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: mockYaml.mutateYaml,
}));

vi.mock("@src/ollama/server.js", () => ({
  getOllamaBridgeStatusForConfig: mockOllamaServer.getOllamaBridgeStatusForConfig,
  restartOllamaBridge: mockOllamaServer.restartOllamaBridge,
}));

import { createOllamaAdminRoutes } from "@src/routes/admin/ollama.js";
import { mutateYaml } from "@src/utils/yaml-mutate.js";
import { reloadAllConfigs } from "@src/config.js";
import { getOllamaBridgeStatusForConfig, restartOllamaBridge } from "@src/ollama/server.js";

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function statusFor(config = state.config, patch: Record<string, unknown> = {}) {
  return {
    enabled: config.ollama.enabled,
    running: config.ollama.enabled,
    host: config.ollama.host,
    port: config.ollama.port,
    endpoint: `http://${endpointHost(config.ollama.host)}:${config.ollama.port}`,
    version: config.ollama.version,
    disable_vision: config.ollama.disable_vision,
    upstream_base_url: "http://127.0.0.1:8080",
    started_at: config.ollama.enabled ? "2026-04-23T00:00:00.000Z" : null,
    error: null,
    ...patch,
  };
}

function createApp(): Hono {
  const app = new Hono();
  app.route("/", createOllamaAdminRoutes());
  return app;
}

describe("Ollama admin settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config = {
      server: { proxy_api_key: null },
      ollama: {
        enabled: false,
        host: "127.0.0.1",
        port: 11434,
        version: "0.18.3",
        disable_vision: false,
      },
    };
    state.restartError = null;
    mockOllamaServer.getOllamaBridgeStatusForConfig.mockImplementation((config) => statusFor(config));
    mockOllamaServer.restartOllamaBridge.mockImplementation(async (config) => {
      if (state.restartError) {
        return statusFor(config, { running: false, error: state.restartError, started_at: null });
      }
      return statusFor(config);
    });
  });

  it("returns current settings with runtime status", async () => {
    state.config.ollama.enabled = true;
    const app = createApp();

    const res = await app.request("/admin/ollama-settings");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 11434,
      version: "0.18.3",
      disable_vision: false,
      status: {
        enabled: true,
        running: true,
        endpoint: "http://127.0.0.1:11434",
      },
    });
    expect(getOllamaBridgeStatusForConfig).toHaveBeenCalledOnce();
  });

  it("returns runtime status directly", async () => {
    const app = createApp();

    const res = await app.request("/admin/ollama-status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      running: false,
      host: "127.0.0.1",
      port: 11434,
    });
  });

  it("persists settings, reloads config, and restarts the bridge", async () => {
    const app = createApp();

    const res = await app.request("/admin/ollama-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        host: " 0.0.0.0 ",
        port: 11435,
        version: " 0.20.1 ",
        disable_vision: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(mutateYaml).toHaveBeenCalledWith("/tmp/test/local.yaml", expect.any(Function));
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    expect(restartOllamaBridge).toHaveBeenCalledWith(state.config);
    expect(state.config.ollama).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 11435,
      version: "0.20.1",
      disable_vision: true,
    });
    const responseText = await res.text();
    expect(responseText.match(/"status":/g)).toHaveLength(1);
    expect(JSON.parse(responseText) as Record<string, unknown>).toMatchObject({
      success: true,
      enabled: true,
      host: "0.0.0.0",
      port: 11435,
      version: "0.20.1",
      disable_vision: true,
      status: {
        running: true,
        endpoint: "http://127.0.0.1:11435",
      },
    });
  });

  // Auth removed from the route itself — `/admin/*` is now uniformly gated by
  // the dashboardAuth middleware, matching the other admin POSTs (quota /
  // rotation / general settings). Middleware-level auth is covered by
  // `tests/unit/middleware/dashboard-auth.test.ts`.

  it("validates host, port, and version before writing config", async () => {
    const app = createApp();
    const cases = [
      { body: { host: "" }, error: "host must be a non-empty hostname or IP address" },
      { body: { host: "bad host" }, error: "host must be a non-empty hostname or IP address" },
      { body: { port: 0 }, error: "port must be an integer between 1 and 65535" },
      { body: { port: 65536 }, error: "port must be an integer between 1 and 65535" },
      { body: { port: 11434.5 }, error: "port must be an integer between 1 and 65535" },
      { body: { version: "" }, error: "version must be a non-empty string up to 64 characters" },
      { body: { version: "x".repeat(65) }, error: "version must be a non-empty string up to 64 characters" },
    ];

    for (const item of cases) {
      const res = await app.request("/admin/ollama-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: item.error });
    }

    expect(mutateYaml).not.toHaveBeenCalled();
    expect(restartOllamaBridge).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed or non-object JSON bodies", async () => {
    const app = createApp();

    const malformed = await app.request("/admin/ollama-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid JSON body" });

    const nonObject = await app.request("/admin/ollama-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["enabled"]),
    });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toEqual({ error: "JSON body must be an object" });

    expect(mutateYaml).not.toHaveBeenCalled();
    expect(restartOllamaBridge).not.toHaveBeenCalled();
  });

  it("returns restart errors in the status payload", async () => {
    state.restartError = "listen EADDRINUSE: address already in use";
    const app = createApp();

    const res = await app.request("/admin/ollama-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      enabled: true,
      status: {
        running: false,
        error: "listen EADDRINUSE: address already in use",
      },
    });
  });
});
