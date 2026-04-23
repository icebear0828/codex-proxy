/**
 * Unit tests for config-schema.ts — Zod schema validation and defaults.
 */

import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  FingerprintSchema,
  ROTATION_STRATEGIES,
} from "@src/config-schema.js";

describe("ROTATION_STRATEGIES", () => {
  it("contains expected values", () => {
    expect(ROTATION_STRATEGIES).toEqual(["least_used", "round_robin", "sticky"]);
  });
});

describe("ConfigSchema", () => {
  it("parses minimal input with all defaults", () => {
    // All top-level required keys with empty objects
    const result = ConfigSchema.parse({
      api: {},
      client: {},
      model: {},
      auth: {},
      server: {},
      session: {},
    });

    expect(result.api.base_url).toBe("https://chatgpt.com/backend-api");
    expect(result.api.timeout_seconds).toBe(60);
    expect(result.server.port).toBe(8080);
    expect(result.server.host).toBe("0.0.0.0");
    expect(result.server.proxy_api_key).toBeNull();
    expect(result.auth.rotation_strategy).toBe("least_used");
    expect(result.auth.refresh_concurrency).toBe(2);
    expect(result.auth.max_concurrent_per_account).toBe(3);
    expect(result.auth.request_interval_ms).toBe(50);
    expect(result.model.default).toBe("gpt-5.4");
    expect(result.model.default_reasoning_effort).toBeNull();
    expect(result.tls.force_http11).toBe(false);
    expect(result.quota.refresh_interval_minutes).toBe(5);
    expect(result.quota.warning_thresholds.primary).toEqual([80, 90]);
    expect(result.quota.skip_exhausted).toBe(true);
    expect(result.update.auto_update).toBe(true);
    expect(result.session.ttl_minutes).toBe(1440);
    expect(result.ollama).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 11434,
      version: "0.18.3",
      disable_vision: false,
    });
  });

  it("respects overridden values", () => {
    const result = ConfigSchema.parse({
      api: { timeout_seconds: 120 },
      client: { platform: "linux" },
      model: { default: "gpt-5.4" },
      auth: { rotation_strategy: "round_robin", max_concurrent_per_account: null },
      server: { port: 3000, proxy_api_key: "sk-test" },
      session: { ttl_minutes: 120 },
      tls: { force_http11: true },
      quota: { skip_exhausted: false },
      update: { auto_update: false },
      ollama: {
        enabled: true,
        host: "0.0.0.0",
        port: 11435,
        version: "0.20.1",
        disable_vision: true,
      },
    });

    expect(result.api.timeout_seconds).toBe(120);
    expect(result.client.platform).toBe("linux");
    expect(result.model.default).toBe("gpt-5.4");
    expect(result.auth.rotation_strategy).toBe("round_robin");
    expect(result.auth.max_concurrent_per_account).toBeNull();
    expect(result.server.port).toBe(3000);
    expect(result.server.proxy_api_key).toBe("sk-test");
    expect(result.tls.force_http11).toBe(true);
    expect(result.quota.skip_exhausted).toBe(false);
    expect(result.update.auto_update).toBe(false);
    expect(result.ollama).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 11435,
      version: "0.20.1",
      disable_vision: true,
    });
  });

  it("rejects port out of range", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: { port: 0 }, session: {},
    });
    expect(result.success).toBe(false);

    const result2 = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: { port: 70000 }, session: {},
    });
    expect(result2.success).toBe(false);
  });

  it("rejects Ollama bridge port out of range", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { port: 0 },
    });
    expect(result.success).toBe(false);

    const result2 = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { port: 70000 },
    });
    expect(result2.success).toBe(false);
  });

  it("trims and validates Ollama bridge version", () => {
    const result = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: " 0.20.1 " },
    });
    expect(result.ollama.version).toBe("0.20.1");

    const empty = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: "   " },
    });
    expect(empty.success).toBe(false);

    const tooLong = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: "x".repeat(65) },
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects invalid rotation strategy", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: { rotation_strategy: "random" }, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_seconds < 1", () => {
    const result = ConfigSchema.safeParse({
      api: { timeout_seconds: 0 }, client: {}, model: {}, auth: {}, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects refresh_concurrency < 1", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: { refresh_concurrency: 0 }, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts tls/quota/update as optional (uses defaults)", () => {
    const result = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
    });
    expect(result.quota.concurrency).toBe(10);
    expect(result.update.auto_update).toBe(true);
  });
});

describe("FingerprintSchema", () => {
  it("parses valid fingerprint config", () => {
    const result = FingerprintSchema.parse({
      user_agent_template: "Codex/{version}",
      auth_domains: ["chatgpt.com"],
      auth_domain_exclusions: [],
      header_order: ["Authorization", "Content-Type"],
    });
    expect(result.user_agent_template).toBe("Codex/{version}");
    expect(result.default_headers).toEqual({});
  });

  it("rejects missing required fields", () => {
    const result = FingerprintSchema.safeParse({
      user_agent_template: "Codex/{version}",
      // Missing auth_domains, auth_domain_exclusions, header_order
    });
    expect(result.success).toBe(false);
  });
});
