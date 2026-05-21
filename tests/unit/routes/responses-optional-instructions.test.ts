/**
 * Tests that /v1/responses works without the `instructions` field.
 * Regression test for: https://github.com/icebear0828/codex-proxy/issues/71
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
  getDataDir: vi.fn(() => "/tmp/test-responses"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-config"),
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

// Capture the codexRequest that handleProxyRequest receives
let capturedCodexRequest: unknown = null;

vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: HandleProxyRequestOptions) => {
    capturedCodexRequest = options.req.codexRequest;
    return options.c.json({ ok: true });
  }),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("/v1/responses — optional instructions", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCodexRequest = null;
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("accepts request without instructions field", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it("accepts request with instructions: null", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        instructions: null,
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it("defaults instructions to empty string when omitted", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(capturedCodexRequest).toBeDefined();
    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.instructions).toBe("");
  });

  it("preserves instructions when provided as string", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        instructions: "You are a helpful assistant.",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(capturedCodexRequest).toBeDefined();
    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.instructions).toBe("You are a helpful assistant.");
  });

  it("marks review quota from x-openai-subagent header", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openai-subagent": "review",
      },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Review this diff" }],
        stream: true,
      }),
    });

    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.client_metadata).toMatchObject({
      "x-openai-subagent": "review",
    });
  });

  it("marks review quota from client_metadata", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Review this diff" }],
        client_metadata: {
          "x-openai-subagent": "review",
          "x-custom": "kept",
          "x-number": 1,
        },
        stream: true,
      }),
    });

    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.client_metadata).toEqual({
      "x-openai-subagent": "review",
      "x-custom": "kept",
    });
  });

  it("provides a dedicated /v1/responses/review endpoint", async () => {
    await app.request("/v1/responses/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Review this diff" }],
        stream: true,
      }),
    });

    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.client_metadata).toMatchObject({
      "x-openai-subagent": "review",
    });
  });

  it("passes through Codex app request fields used by review subagents", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codex-turn-state": "turn-state-1",
        "x-codex-turn-metadata": "{\"session_id\":\"thread-1\",\"thread_source\":\"subagent\"}",
        "x-codex-beta-features": "feature-a",
        "x-responsesapi-include-timing-metrics": "true",
        "x-codex-window-id": "thread-1:0",
        "x-codex-parent-thread-id": "parent-1",
        "Version": "26.318.11754",
      },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        prompt_cache_key: "thread-1",
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
      }),
    });

    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.prompt_cache_key).toBe("thread-1");
    expect(req.include).toEqual(["reasoning.encrypted_content"]);
    expect(req.parallel_tool_calls).toBe(false);
    expect(req.turnState).toBe("turn-state-1");
    expect(req.turnMetadata).toBe("{\"session_id\":\"thread-1\",\"thread_source\":\"subagent\"}");
    expect(req.betaFeatures).toBe("feature-a");
    expect(req.includeTimingMetrics).toBe("true");
    expect(req.codexWindowId).toBe("thread-1:0");
    expect(req.parentThreadId).toBe("parent-1");
    expect(req.version).toBe("26.318.11754");
  });

  it("still rejects non-object body", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an object"),
    });

    expect(res.status).toBe(400);
  });
});
