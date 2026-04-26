import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AppConfig } from "../config-schema.js";
import { createOllamaBridgeApp } from "./bridge.js";

type ServerType = HttpServer | Http2Server | Http2SecureServer;

export interface OllamaBridgeRuntime {
  upstreamBaseUrl: string;
}

export interface OllamaBridgeStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  endpoint: string;
  version: string;
  disable_vision: boolean;
  upstream_base_url: string | null;
  started_at: string | null;
  error: string | null;
}

let server: ServerType | null = null;
let runtime: OllamaBridgeRuntime | null = null;
let status: OllamaBridgeStatus = {
  enabled: false,
  running: false,
  host: "127.0.0.1",
  port: 11434,
  endpoint: "http://127.0.0.1:11434",
  version: "0.18.3",
  disable_vision: false,
  upstream_base_url: null,
  started_at: null,
  error: null,
};

function endpointHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function endpointFor(host: string, port: number): string {
  return `http://${endpointHost(host)}:${port}`;
}

function configStatus(config: AppConfig, next: Partial<OllamaBridgeStatus> = {}): OllamaBridgeStatus {
  return {
    enabled: config.ollama.enabled,
    running: false,
    host: config.ollama.host,
    port: config.ollama.port,
    endpoint: endpointFor(config.ollama.host, config.ollama.port),
    version: config.ollama.version,
    disable_vision: config.ollama.disable_vision,
    upstream_base_url: runtime?.upstreamBaseUrl ?? null,
    started_at: null,
    error: null,
    ...next,
  };
}

function waitForListening(nextServer: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      nextServer.off("listening", onListening);
      nextServer.off("error", onError);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onListening = () => settle(resolve);
    const onError = (err: Error) => settle(() => reject(err));
    nextServer.once("listening", onListening);
    nextServer.once("error", onError);
    if (nextServer.address()) {
      setImmediate(onListening);
    }
  });
}

export async function stopOllamaBridge(): Promise<void> {
  if (!server) {
    status = { ...status, running: false, started_at: null };
    return;
  }
  const current = server;
  server = null;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
  });
  status = { ...status, running: false, started_at: null };
}

export async function startOllamaBridge(
  config: AppConfig,
  nextRuntime: OllamaBridgeRuntime,
): Promise<OllamaBridgeStatus> {
  runtime = nextRuntime;
  await stopOllamaBridge();
  status = configStatus(config);

  if (!config.ollama.enabled) {
    console.log("[OllamaBridge] Disabled");
    return status;
  }

  const app = createOllamaBridgeApp({
    upstreamBaseUrl: nextRuntime.upstreamBaseUrl,
    proxyApiKey: config.server.proxy_api_key,
    version: config.ollama.version,
    disableVision: config.ollama.disable_vision,
  });

  try {
    const nextServer = serve({
      fetch: app.fetch,
      hostname: config.ollama.host,
      port: config.ollama.port,
    });
    await waitForListening(nextServer);
    server = nextServer;
    const addr = nextServer.address();
    const actualPort = addr && typeof addr === "object"
      ? (addr as AddressInfo).port
      : config.ollama.port;
    status = configStatus(config, {
      running: true,
      port: actualPort,
      endpoint: endpointFor(config.ollama.host, actualPort),
      upstream_base_url: nextRuntime.upstreamBaseUrl,
      started_at: new Date().toISOString(),
    });
    console.log(`[OllamaBridge] Listening on ${status.endpoint}`);
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status = configStatus(config, {
      error: message,
      upstream_base_url: nextRuntime.upstreamBaseUrl,
    });
    console.warn(`[OllamaBridge] Failed to start: ${message}`);
    return status;
  }
}

export async function restartOllamaBridge(config: AppConfig): Promise<OllamaBridgeStatus> {
  if (!runtime) {
    status = configStatus(config, { error: "Ollama bridge runtime is not initialized" });
    return status;
  }
  return startOllamaBridge(config, runtime);
}

/** Live runtime status — reflects whatever the running bridge last reported. */
export function getOllamaBridgeRuntimeStatus(): OllamaBridgeStatus {
  return status;
}

/** Runtime status overlaid with the current `config.ollama.*` values. Use this
 *  for endpoints that need to show "what the user has configured" alongside
 *  "what is currently running" — when the bridge is stopped, fields like
 *  port/endpoint fall back to the config so the UI can reflect pending changes. */
export function getOllamaBridgeStatusForConfig(config: AppConfig): OllamaBridgeStatus {
  return {
    ...status,
    enabled: config.ollama.enabled,
    host: config.ollama.host,
    version: config.ollama.version,
    disable_vision: config.ollama.disable_vision,
    port: status.running ? status.port : config.ollama.port,
    endpoint: status.running ? status.endpoint : endpointFor(config.ollama.host, config.ollama.port),
  };
}
