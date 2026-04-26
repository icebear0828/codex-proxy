import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@src/config-schema.js";

const mockServe = vi.hoisted(() => vi.fn());

vi.mock("@hono/node-server", () => ({
  serve: mockServe,
}));

interface FakeServer extends EventEmitter {
  address: () => { address: string; family: string; port: number } | null;
  close: (callback?: () => void) => void;
}

function createConfig(patch: Partial<AppConfig["ollama"]> = {}): AppConfig {
  return {
    api: { base_url: "https://example.test", timeout_seconds: 60 },
    client: {
      originator: "Codex Desktop",
      app_version: "1",
      build_number: "1",
      platform: "linux",
      arch: "x64",
      chromium_version: "1",
    },
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      inject_desktop_context: false,
      suppress_desktop_directives: true,
    },
    auth: {
      jwt_token: null,
      chatgpt_oauth: true,
      refresh_margin_seconds: 300,
      refresh_enabled: true,
      refresh_concurrency: 2,
      max_concurrent_per_account: 3,
      request_interval_ms: 50,
      rotation_strategy: "least_used",
      tier_priority: null,
      rate_limit_backoff_seconds: 60,
      oauth_client_id: "app",
      oauth_auth_endpoint: "https://auth.example.test",
      oauth_token_endpoint: "https://token.example.test",
    },
    server: { host: "127.0.0.1", port: 8080, proxy_api_key: "secret", trust_proxy: false },
    logs: { enabled: false, capacity: 2000, capture_body: false, llm_only: true },
    session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
    tls: { proxy_url: null, force_http11: false },
    quota: {
      refresh_interval_minutes: 5,
      concurrency: 10,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    },
    update: { auto_update: true, auto_download: false },
    ollama: {
      enabled: true,
      host: "127.0.0.1",
      port: 11434,
      version: "0.18.3",
      disable_vision: false,
      ...patch,
    },
    providers: { custom: {} },
    model_routing: {},
  };
}

function createFakeServer(port: number, error?: Error): FakeServer {
  let listening = false;
  const server = new EventEmitter() as FakeServer;
  server.address = vi.fn(() => listening ? { address: "127.0.0.1", family: "IPv4", port } : null);
  server.close = vi.fn((callback?: () => void) => {
    listening = false;
    callback?.();
  });
  queueMicrotask(() => {
    if (error) {
      server.emit("error", error);
      return;
    }
    listening = true;
    server.emit("listening");
  });
  return server;
}

async function loadModule() {
  vi.resetModules();
  return import("@src/ollama/server.js");
}

describe("Ollama bridge server lifecycle", () => {
  beforeEach(() => {
    mockServe.mockReset();
  });

  it("does not start a listener when disabled", async () => {
    const { startOllamaBridge } = await loadModule();

    const status = await startOllamaBridge(createConfig({ enabled: false }), {
      upstreamBaseUrl: "http://127.0.0.1:8080",
    });

    expect(mockServe).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      enabled: false,
      running: false,
      host: "127.0.0.1",
      port: 11434,
      endpoint: "http://127.0.0.1:11434",
      error: null,
    });
  });

  it("starts the listener and reports the externally usable endpoint", async () => {
    mockServe.mockReturnValueOnce(createFakeServer(49152));
    const { startOllamaBridge, getOllamaBridgeStatusForConfig, stopOllamaBridge } = await loadModule();
    const config = createConfig({ host: "0.0.0.0", port: 0, disable_vision: true });

    const status = await startOllamaBridge(config, {
      upstreamBaseUrl: "http://127.0.0.1:8080",
    });

    expect(mockServe).toHaveBeenCalledOnce();
    expect(mockServe.mock.calls[0][0]).toMatchObject({
      hostname: "0.0.0.0",
      port: 0,
    });
    expect(status).toMatchObject({
      enabled: true,
      running: true,
      host: "0.0.0.0",
      port: 49152,
      endpoint: "http://127.0.0.1:49152",
      disable_vision: true,
      upstream_base_url: "http://127.0.0.1:8080",
      error: null,
    });
    expect(status.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await stopOllamaBridge();
    expect(getOllamaBridgeStatusForConfig(config)).toMatchObject({
      running: false,
      port: 0,
      endpoint: "http://127.0.0.1:0",
    });
  });

  it("restarts using the remembered runtime", async () => {
    const first = createFakeServer(11434);
    const second = createFakeServer(11435);
    mockServe.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { startOllamaBridge, restartOllamaBridge } = await loadModule();
    const config = createConfig();

    await startOllamaBridge(config, { upstreamBaseUrl: "http://127.0.0.1:8080" });
    const status = await restartOllamaBridge(createConfig({ port: 11435 }));

    expect(first.close).toHaveBeenCalledOnce();
    expect(mockServe).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      running: true,
      port: 11435,
      endpoint: "http://127.0.0.1:11435",
      upstream_base_url: "http://127.0.0.1:8080",
    });
  });

  it("reports an error when restart is requested before runtime initialization", async () => {
    const { restartOllamaBridge } = await loadModule();

    const status = await restartOllamaBridge(createConfig());

    expect(status).toMatchObject({
      running: false,
      error: "Ollama bridge runtime is not initialized",
    });
    expect(mockServe).not.toHaveBeenCalled();
  });

  it("records bind failures without throwing", async () => {
    mockServe.mockImplementationOnce(() => createFakeServer(
      11434,
      new Error("listen EADDRINUSE: address already in use"),
    ));
    const { startOllamaBridge } = await loadModule();

    const status = await startOllamaBridge(createConfig(), {
      upstreamBaseUrl: "http://127.0.0.1:8080",
    });

    expect(status).toMatchObject({
      enabled: true,
      running: false,
      host: "127.0.0.1",
      port: 11434,
      endpoint: "http://127.0.0.1:11434",
      upstream_base_url: "http://127.0.0.1:8080",
      error: "listen EADDRINUSE: address already in use",
    });
  });
});
