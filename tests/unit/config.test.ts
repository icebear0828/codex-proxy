/**
 * Tests for config.ts — YAML loading + env overrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

vi.mock("@src/models/model-store.js", () => ({
  loadStaticModels: vi.fn(),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

import { readFileSync } from "fs";

const DEFAULT_YAML = `
api:
  base_url: "https://chatgpt.com/backend-api"
  timeout_seconds: 60
client:
  originator: "Codex Desktop"
  app_version: "260202.0859"
  build_number: "517"
  platform: "darwin"
  arch: "arm64"
  chromium_version: "136"
model:
  default: "gpt-5.2-codex"
  default_reasoning_effort: null
  default_service_tier: null
  suppress_desktop_directives: true
auth:
  jwt_token: null
  chatgpt_oauth: true
  refresh_margin_seconds: 300
  rotation_strategy: "least_used"
  rate_limit_backoff_seconds: 60
  oauth_client_id: "app_test"
  oauth_auth_endpoint: "https://auth.openai.com/oauth/authorize"
  oauth_token_endpoint: "https://auth.openai.com/oauth/token"
server:
  host: "0.0.0.0"
  port: 8080
  proxy_api_key: null
session:
  ttl_minutes: 60
  cleanup_interval_minutes: 5
`;

const FINGERPRINT_YAML = `
user_agent_template: "CodexDesktop/{version} ({platform}; {arch})"
auth_domains:
  - chatgpt.com
auth_domain_exclusions: []
header_order:
  - Authorization
  - User-Agent
default_headers:
  Accept-Encoding: "gzip, deflate, br, zstd"
`;

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.mocked(readFileSync).mockImplementation(((path: string) => {
      if (path.includes("default.yaml")) return DEFAULT_YAML;
      if (path.includes("fingerprint.yaml")) return FINGERPRINT_YAML;
      throw new Error("ENOENT");
    }) as typeof readFileSync);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads and parses default config", async () => {
    const { loadConfig } = await import("@src/config.js");
    const config = loadConfig("/tmp/test-config");
    expect(config.api.base_url).toBe("https://chatgpt.com/backend-api");
    expect(config.server.port).toBe(8080);
    expect(config.model.default).toBe("gpt-5.2-codex");
  });

  it("loads fingerprint config", async () => {
    const { loadFingerprint } = await import("@src/config.js");
    const fp = loadFingerprint("/tmp/test-config");
    expect(fp.user_agent_template).toContain("CodexDesktop");
    expect(fp.header_order).toContain("Authorization");
  });

  it("applies CODEX_JWT_TOKEN env override (valid JWT prefix)", async () => {
    process.env.CODEX_JWT_TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.";
    const { loadConfig } = await import("@src/config.js");
    const config = loadConfig("/tmp/test-config");
    expect(config.auth.jwt_token).toBe("eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.");
  });

  it("ignores CODEX_JWT_TOKEN without eyJ prefix", async () => {
    process.env.CODEX_JWT_TOKEN = "not-a-jwt";
    const { loadConfig } = await import("@src/config.js");
    const config = loadConfig("/tmp/test-config");
    expect(config.auth.jwt_token).toBeNull();
  });

  it("applies PORT env override", async () => {
    process.env.PORT = "9090";
    const { loadConfig } = await import("@src/config.js");
    const config = loadConfig("/tmp/test-config");
    expect(config.server.port).toBe(9090);
  });

  it("getConfig throws before loadConfig", async () => {
    const { getConfig } = await import("@src/config.js");
    expect(() => getConfig()).toThrow("Config not loaded");
  });

  it("getFingerprint throws before loadFingerprint", async () => {
    const { getFingerprint } = await import("@src/config.js");
    expect(() => getFingerprint()).toThrow("Fingerprint not loaded");
  });
});
