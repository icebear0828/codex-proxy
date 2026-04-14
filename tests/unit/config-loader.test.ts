/**
 * Unit tests for config-loader.ts — deepMerge, loadMergedConfig, applyEnvOverrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/fake/config"),
  getDataDir: vi.fn(() => "/fake/data"),
}));

import { readFileSync, existsSync, writeFileSync } from "fs";
import { deepMerge, loadMergedConfig, applyEnvOverrides } from "@src/config-loader.js";

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

// ── deepMerge ────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep merges nested objects", () => {
    const target = { server: { port: 8080, host: "0.0.0.0" } };
    const source = { server: { port: 9090 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ server: { port: 9090, host: "0.0.0.0" } });
  });

  it("replaces arrays instead of merging", () => {
    const target = { tags: [1, 2, 3] };
    const source = { tags: [4, 5] };
    const result = deepMerge(target, source);
    expect(result.tags).toEqual([4, 5]);
  });

  it("handles null values in source", () => {
    const target = { a: { nested: true } };
    const source = { a: null };
    const result = deepMerge(target, source as Record<string, unknown>);
    expect(result.a).toBeNull();
  });

  it("handles null values in target being overwritten by object", () => {
    const target = { a: null } as Record<string, unknown>;
    const source = { a: { nested: true } };
    const result = deepMerge(target, source);
    expect(result.a).toEqual({ nested: true });
  });

  it("adds new keys from source", () => {
    const target = {};
    const source = { newKey: "value" };
    const result = deepMerge(target, source);
    expect(result.newKey).toBe("value");
  });
});

// ── loadMergedConfig ─────────────────────────────────────────────

describe("loadMergedConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads default.yaml and returns raw config", () => {
    mockReadFileSync.mockReturnValue("server:\n  port: 8080\n");
    mockExistsSync.mockReturnValue(false);

    const { raw, local } = loadMergedConfig();
    expect(raw).toEqual({ server: { port: 8080 } });
    expect(local).toBeNull();
  });

  it("merges local.yaml when it exists", () => {
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "server:\n  port: 8080\n  host: '0.0.0.0'\n";
      return "server:\n  port: 9090\n";
    });
    // First call: existsSync for local.yaml check before create, second: for load
    mockExistsSync.mockReturnValue(true);

    const { raw, local } = loadMergedConfig();
    expect(raw.server).toEqual({ port: 9090, host: "0.0.0.0" });
    expect(local).toEqual({ server: { port: 9090 } });
  });

  it("creates local.yaml when it does not exist", () => {
    mockReadFileSync.mockReturnValue("server:\n  port: 8080\n");
    // First existsSync(localPath) returns false, second returns true after write
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);

    loadMergedConfig();
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("local.yaml"),
      expect.stringContaining("proxy_api_key"),
      "utf-8",
    );
  });
});

// ── applyEnvOverrides ────────────────────────────────────────────

describe("applyEnvOverrides", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CODEX_JWT_TOKEN = process.env.CODEX_JWT_TOKEN;
    savedEnv.CODEX_PLATFORM = process.env.CODEX_PLATFORM;
    savedEnv.CODEX_ARCH = process.env.CODEX_ARCH;
    savedEnv.PORT = process.env.PORT;
    savedEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;
    savedEnv.https_proxy = process.env.https_proxy;
    // Clear
    delete process.env.CODEX_JWT_TOKEN;
    delete process.env.CODEX_PLATFORM;
    delete process.env.CODEX_ARCH;
    delete process.env.PORT;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
  });

  afterEach(() => {
    // Restore
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("applies valid JWT from env", () => {
    process.env.CODEX_JWT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.test";
    const raw = { auth: { jwt_token: null } } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.auth as Record<string, unknown>).jwt_token).toBe("eyJhbGciOiJSUzI1NiJ9.test");
  });

  it("ignores JWT that does not start with eyJ", () => {
    process.env.CODEX_JWT_TOKEN = "not-a-jwt";
    const raw = { auth: { jwt_token: null } } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.auth as Record<string, unknown>).jwt_token).toBeNull();
  });

  it("applies PORT as integer", () => {
    process.env.PORT = "3000";
    const raw = { server: { port: 8080 }, auth: {} } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.server as Record<string, unknown>).port).toBe(3000);
  });

  it("ignores non-numeric PORT", () => {
    process.env.PORT = "abc";
    const raw = { server: { port: 8080 }, auth: {} } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.server as Record<string, unknown>).port).toBe(8080);
  });

  it("applies HTTPS_PROXY when local.yaml has no proxy_url", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    const raw = { auth: {}, server: {} } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.tls as Record<string, unknown>).proxy_url).toBe("http://proxy.example.com:8080");
  });

  it("skips HTTPS_PROXY when local.yaml has proxy_url set", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const raw = { auth: {}, server: {}, tls: { proxy_url: "http://local-proxy:8080" } } as Record<string, unknown>;
    const localOverrides = { tls: { proxy_url: "http://local-proxy:8080" } };
    applyEnvOverrides(raw, localOverrides);
    expect((raw.tls as Record<string, unknown>).proxy_url).toBe("http://local-proxy:8080");
  });

  it("applies CODEX_PLATFORM and CODEX_ARCH", () => {
    process.env.CODEX_PLATFORM = "linux";
    process.env.CODEX_ARCH = "x86_64";
    const raw = { auth: {}, server: {}, client: { platform: "darwin", arch: "arm64" } } as Record<string, unknown>;
    applyEnvOverrides(raw, null);
    expect((raw.client as Record<string, unknown>).platform).toBe("linux");
    expect((raw.client as Record<string, unknown>).arch).toBe("x86_64");
  });
});
