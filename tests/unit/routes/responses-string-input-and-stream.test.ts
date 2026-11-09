/**
 * Tests for /v1/responses string input normalization and stream parameter defaulting.
 * Regression test for: https://github.com/icebear0828/codex-proxy/issues/866
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { HandleProxyRequestOptions } from "@src/routes/shared/proxy-handler-types.js";

// ── Mocks (before imports) ──────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.3-codex",
    default_reasoning_effort: null,
    default_service_tier: null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-responses-866"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-866-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) =>
        cb(null),
    ),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

let capturedProxyReq: HandleProxyRequestOptions["req"] | null = null;

vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: HandleProxyRequestOptions) => {
    capturedProxyReq = options.req;
    return options.c.json({ ok: true });
  }),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("/v1/responses — string input and stream default (Issue #866)", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedProxyReq = null;
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("normalizes string input into a user message with input_text", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: "Reply only OK.",
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedProxyReq).toBeDefined();
    expect(capturedProxyReq?.codexRequest.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Reply only OK." }] },
    ]);
  });

  it("preserves array input items", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello world" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedProxyReq?.codexRequest.input).toEqual([
      { role: "user", content: "Hello world" },
    ]);
  });

  it("defaults stream to false (non-streaming) when omitted", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: "Reply only OK.",
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedProxyReq?.isStreaming).toBe(false);
  });

  it("sets isStreaming to false when stream is explicitly false", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: "Reply only OK.",
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedProxyReq?.isStreaming).toBe(false);
  });

  it("sets isStreaming to true when stream is explicitly true", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: "Reply only OK.",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedProxyReq?.isStreaming).toBe(true);
  });
});
