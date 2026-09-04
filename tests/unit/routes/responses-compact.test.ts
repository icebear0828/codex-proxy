/**
 * Tests for POST /v1/responses/compact.
 *
 * Compact is a non-streaming JSON endpoint (unlike regular /v1/responses which is SSE).
 * codex-rs sends CompactionInput { model, input, instructions, tools, reasoning, text }
 * and expects back { output: ResponseItem[] }.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono, type Context } from "hono";
import type { HandleDirectRequestOptions } from "@src/routes/shared/proxy-handler-types.js";

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
  getDataDir: vi.fn(() => "/tmp/test-compact"),
  getConfigDir: vi.fn(() => "/tmp/test-compact-config"),
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

// Mock shared proxy/direct handlers
const mockHandleDirectRequest = vi.fn(async (options: HandleDirectRequestOptions) => options.c.json({ ok: true }));
vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: { c: Context }) => options.c.json({ ok: true })),
}));
vi.mock("@src/routes/shared/proxy-stagger.js", () => ({
  staggerIfNeeded: vi.fn(async () => {}),
}));
vi.mock("@src/routes/shared/direct-request-handler.js", () => ({
  handleDirectRequest: (options: HandleDirectRequestOptions) => mockHandleDirectRequest(options),
}));

// Capture compact requests by mocking CodexApi
let capturedCompactRequest: unknown = null;
let mockCompactResponse: unknown = { output: [{ role: "user", content: "compacted" }] };
let mockCompactThrow: (() => never) | null = null;

vi.mock("@src/proxy/codex-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/proxy/codex-api.js")>();
  return {
    ...actual,
    CodexApi: vi.fn().mockImplementation(() => ({
      createCompactResponse: vi.fn(async (req: unknown) => {
        capturedCompactRequest = req;
        if (mockCompactThrow) mockCompactThrow();
        return mockCompactResponse;
      }),
      createResponse: vi.fn(),
      parseStream: vi.fn(),
    })),
  };
});

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { CodexApiError } from "@src/proxy/codex-types.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /v1/responses/compact", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCompactRequest = null;
    mockCompactResponse = { output: [{ role: "user", content: "compacted" }] };
    mockCompactThrow = null;
    mockConfig.server.proxy_api_key = null;
    mockHandleDirectRequest.mockImplementation(async (options: HandleDirectRequestOptions) => options.c.json({ ok: true }));
    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("returns 200 with compact response", async () => {
    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        instructions: "You are helpful",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ output: [{ role: "user", content: "compacted" }] });
  });

  it("rejects an unrecognized model with model_not_found instead of falling back to default", async () => {
    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "totally-unknown",
        input: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.param).toBe("model");
    expect(capturedCompactRequest).toBeNull();
  });

  it("routes compact requests for runtime API-key models to direct upstream", async () => {
    const upstreamRouter = {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "my-custom-model",
        input: [{ role: "user", content: "Hello" }],
        instructions: "You are helpful",
        parallel_tool_calls: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    const directReq = mockHandleDirectRequest.mock.calls[0][0].req as Record<string, unknown>;
    expect(directReq.model).toBe("my-custom-model");
    expect(directReq.isStreaming).toBe(false);
    expect(directReq.codexRequest).toEqual({
      model: "my-custom-model",
      input: [{ role: "user", content: "Hello" }],
      instructions: "You are helpful",
      parallel_tool_calls: true,
      stream: true,
      store: false,
    });
    expect(capturedCompactRequest).toBeNull();
  });

  it("uses the remote compact endpoint when the adapter declares Codex JSON support", async () => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ output: [{ role: "user", content: "remote compact" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const upstreamRouter = {
      resolveMatch: vi.fn(() => ({
        kind: "adapter",
        adapter: { tag: "codex-responses", forwardCodexJsonRequest },
      })),
    };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);
    const requestBody = {
      model: "my-custom-model",
      input: [{ role: "user", content: "Hello" }],
      instructions: "You are helpful",
      provider_extension: { preserved: true },
    };

    const res = await app.request("/responses/compact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codex-turn-state": "turn-state-1",
      },
      body: JSON.stringify(requestBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      output: [{ role: "user", content: "remote compact" }],
    });
    expect(forwardCodexJsonRequest).toHaveBeenCalledWith(
      "responses/compact",
      requestBody,
      expect.any(AbortSignal),
      expect.objectContaining({ turnState: "turn-state-1" }),
    );
    expect(mockHandleDirectRequest).not.toHaveBeenCalled();
    expect(capturedCompactRequest).toBeNull();
  });

  it.each([
    ["/v1/alpha/search", "alpha/search"],
    ["/alpha/search", "alpha/search"],
    ["/v1/images/generations", "images/generations"],
    ["/v1/images/edits", "images/edits"],
  ] as const)("forwards Codex auxiliary route %s", async (incomingPath, upstreamPath) => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ endpoint: upstreamPath, ok: true }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "upstream-rid",
          "x-ratelimit-remaining-requests": "7",
          "Set-Cookie": "provider-secret=hidden",
          "Set-Cookie2": "provider-secret-2=hidden",
          Authorization: "Bearer upstream-secret",
          "X-Api-Key": "upstream-secret",
          Cookie: "provider-cookie=hidden",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        },
      },
    ));
    const upstreamRouter = {
      resolveMatch: vi.fn(() => ({
        kind: "api-key",
        adapter: { tag: "codex-responses", forwardCodexJsonRequest },
      })),
    };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);
    const requestBody = {
      id: "aux-1",
      model: "my-custom-model",
      input: [{ type: "search_query", q: "OpenAI docs" }],
    };

    const res = await app.request(incomingPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codex-turn-state": "turn-state-1",
      },
      body: JSON.stringify(requestBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("upstream-rid");
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("7");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("set-cookie2")).toBeNull();
    expect(res.headers.get("authorization")).toBeNull();
    expect(res.headers.get("x-api-key")).toBeNull();
    expect(res.headers.get("cookie")).toBeNull();
    expect(res.headers.get("x-accel-buffering")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
    await expect(res.json()).resolves.toEqual({ endpoint: upstreamPath, ok: true });
    expect(forwardCodexJsonRequest).toHaveBeenCalledWith(
      upstreamPath,
      requestBody,
      expect.any(AbortSignal),
      expect.objectContaining({ turnState: "turn-state-1" }),
    );
  });

  it("preserves non-2xx auxiliary status, body, and safe retry headers", async () => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
          "Proxy-Authenticate": "Basic realm=upstream",
        },
      },
    ));
    const upstreamRouter = {
      resolveMatch: vi.fn(() => ({
        kind: "api-key",
        adapter: { tag: "codex-responses", forwardCodexJsonRequest },
      })),
    };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);

    const res = await app.request("/v1/alpha/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "my-custom-model", input: [] }),
    });

    expect(res.status).toBe(429);
    expect(res.statusText).toBe("Too Many Requests");
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("proxy-authenticate")).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: { message: "rate limited" } });
  });

  it("fails closed when an auxiliary model is not routed to a Codex JSON adapter", async () => {
    const upstreamRouter = {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "responses" } })),
    };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);

    const res = await app.request("/v1/alpha/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "my-custom-model", input: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_codex_auxiliary_route");
    expect(mockHandleDirectRequest).not.toHaveBeenCalled();
  });

  it("requires a model for auxiliary routing", async () => {
    const upstreamRouter = { resolveMatch: vi.fn() };
    app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter as never);

    const res = await app.request("/v1/alpha/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("missing_model");
    expect(upstreamRouter.resolveMatch).not.toHaveBeenCalled();
  });

  it("sends correct CompactRequest format (no stream/store)", async () => {
    await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        instructions: "Be concise",
        tools: [{ type: "function", function: { name: "read_file" } }],
        parallel_tool_calls: true,
        reasoning: { effort: "medium", summary: "auto" },
      }),
    });

    expect(capturedCompactRequest).toBeDefined();
    const req = capturedCompactRequest as Record<string, unknown>;

    // Must NOT have streaming fields
    expect(req).not.toHaveProperty("stream");
    expect(req).not.toHaveProperty("store");
    expect(req).not.toHaveProperty("compact");
    expect(req).not.toHaveProperty("useWebSocket");
    expect(req).not.toHaveProperty("previous_response_id");

    // Must have compact fields
    expect(req.model).toBe("gpt-5.3-codex");
    expect(req.instructions).toBe("Be concise");
    expect(req.input).toEqual([{ role: "user", content: "Hello" }]);
    expect(req.tools).toEqual([{ type: "function", function: { name: "read_file" } }]);
    expect(req.parallel_tool_calls).toBe(true);
    expect(req.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("passes through text format", async () => {
    await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [],
        instructions: "",
        text: {
          format: {
            type: "json_schema",
            name: "result",
            schema: { type: "object" },
            strict: true,
          },
        },
      }),
    });

    expect(capturedCompactRequest).toBeDefined();
    const req = capturedCompactRequest as Record<string, unknown>;
    const text = req.text as Record<string, unknown>;
    const format = text.format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("result");
    expect(format.strict).toBe(true);
  });

  it("sanitizes reasoning input items before compact forwarding", async () => {
    await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "",
            signature: "unsupported",
            content: [{ type: "reasoning_text", text: "kept" }],
          },
          { type: "compaction", encrypted_content: 123 },
          { role: "user", content: "Hello" },
        ],
        instructions: "",
      }),
    });

    const req = capturedCompactRequest as Record<string, unknown>;
    expect(req.input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [{ type: "reasoning_text", text: "kept" }],
      },
      { role: "user", content: "Hello" },
    ]);
  });

  it("defaults instructions to empty string when omitted", async () => {
    await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [],
      }),
    });

    const req = capturedCompactRequest as Record<string, unknown>;
    expect(req.instructions).toBe("");
  });

  it("returns 401 when not authenticated", async () => {
    const emptyPool = new AccountPool();
    const emptyApp = createResponsesRoutes(emptyPool);

    const res = await emptyApp.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex", input: [] }),
    });

    expect(res.status).toBe(401);
    emptyPool.destroy();
  });

  it("returns 401 with wrong proxy API key", async () => {
    mockConfig.server.proxy_api_key = "correct-key";

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ model: "codex", input: [] }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns error when upstream fails", async () => {
    mockCompactThrow = () => {
      throw new CodexApiError(500, '{"detail":"Internal server error"}');
    };

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        instructions: "",
      }),
    });

    // Single account in pool → no retry fallback → returns error
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.type).toBe("error");
  });

  it("returns 400 for non-object body", async () => {
    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("string"),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });
});
