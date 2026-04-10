/**
 * Tests for hasLocalOverride() — ensures user's local.yaml overrides
 * are tracked and queryable (used by startServer to respect Electron host config).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// Mock model-store and model-fetcher (imported by config.ts)
vi.mock("../models/model-store.js", () => ({
  loadStaticModels: vi.fn(),
}));
vi.mock("../models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

function makeTempConfig(defaultYaml: string, localYaml?: string): string {
  const id = randomUUID().slice(0, 8);
  const base = resolve(tmpdir(), `config-test-${id}`);
  const configDir = resolve(base, "config");
  const dataDir = resolve(base, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(configDir, "default.yaml"), defaultYaml, "utf-8");
  if (localYaml) {
    writeFileSync(resolve(dataDir, "local.yaml"), localYaml, "utf-8");
  }
  return configDir;
}

const MINIMAL_DEFAULT = `
api:
  base_url: https://example.com
  timeout_seconds: 30
client:
  originator: Test
  app_version: "1.0"
  build_number: "1"
  platform: darwin
  arch: arm64
  chromium_version: "136"
model:
  default: test-model
  default_reasoning_effort: null
  default_service_tier: null
  inject_desktop_context: false
  suppress_desktop_directives: false
auth:
  jwt_token: null
  chatgpt_oauth: true
  refresh_enabled: true
  refresh_margin_seconds: 300
  rotation_strategy: least_used
  rate_limit_backoff_seconds: 60
  oauth_client_id: test
  oauth_auth_endpoint: https://example.com
  oauth_token_endpoint: https://example.com
server:
  host: "::"
  port: 8080
  proxy_api_key: null
session:
  ttl_minutes: 60
  cleanup_interval_minutes: 5
`;

describe("hasLocalOverride", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns false when no local.yaml exists", async () => {
    const configDir = makeTempConfig(MINIMAL_DEFAULT);
    // Remove auto-created local.yaml (loadConfig creates one if missing)
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    loadConfig(configDir);

    expect(hasLocalOverride("server", "host")).toBe(false);
    expect(hasLocalOverride("server", "port")).toBe(false);
  });

  it("returns true for keys explicitly set in local.yaml", async () => {
    const localYaml = `
server:
  host: "0.0.0.0"
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    loadConfig(configDir);

    expect(hasLocalOverride("server", "host")).toBe(true);
    expect(hasLocalOverride("server", "port")).toBe(false);
  });

  it("returns false for unrelated paths", async () => {
    const localYaml = `
server:
  host: "0.0.0.0"
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    loadConfig(configDir);

    expect(hasLocalOverride("auth", "host")).toBe(false);
    expect(hasLocalOverride("nonexistent")).toBe(false);
    expect(hasLocalOverride("server", "host", "deep")).toBe(false);
  });

  it("reflects updated overrides after reloadConfig", async () => {
    const configDir = makeTempConfig(MINIMAL_DEFAULT);
    const { loadConfig, reloadConfig, hasLocalOverride } = await import("../config.js");
    loadConfig(configDir);
    expect(hasLocalOverride("server", "host")).toBe(false);

    // Write a local.yaml and reload
    const dataDir = resolve(configDir, "..", "data");
    writeFileSync(resolve(dataDir, "local.yaml"), 'server:\n  host: "0.0.0.0"\n', "utf-8");
    reloadConfig(configDir);

    expect(hasLocalOverride("server", "host")).toBe(true);
  });

  it("returns false when local.yaml has unrelated keys only", async () => {
    const localYaml = `
auth:
  rotation_strategy: round_robin
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    loadConfig(configDir);

    expect(hasLocalOverride("server", "host")).toBe(false);
    expect(hasLocalOverride("auth", "rotation_strategy")).toBe(true);
  });

  it("merged config uses local.yaml value over default", async () => {
    const localYaml = `
server:
  host: "0.0.0.0"
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig } = await import("../config.js");
    const config = loadConfig(configDir);

    expect(config.server.host).toBe("0.0.0.0");
  });

  it("local.yaml host overrides Electron programmatic default", async () => {
    const localYaml = `
server:
  host: "0.0.0.0"
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    const config = loadConfig(configDir);

    // Simulate startServer host resolution (src/index.ts:103-105)
    const electronDefault = "127.0.0.1";
    const resolved = hasLocalOverride("server", "host")
      ? config.server.host
      : electronDefault;

    expect(resolved).toBe("0.0.0.0");
  });

  it("falls back to Electron default when local.yaml has no host", async () => {
    const localYaml = `
server:
  proxy_api_key: test-key
`;
    const configDir = makeTempConfig(MINIMAL_DEFAULT, localYaml);
    const { loadConfig, hasLocalOverride } = await import("../config.js");
    const config = loadConfig(configDir);

    const electronDefault = "127.0.0.1";
    const resolved = hasLocalOverride("server", "host")
      ? config.server.host
      : (electronDefault ?? config.server.host);

    expect(resolved).toBe("127.0.0.1");
  });
});
