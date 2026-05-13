/**
 * Tests for upstream error forwarding in handleDirectRequest and handleProxyRequest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { FormatStreamTranslatorOptions, ProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

// ── Mocks ────────────────────────────────────────────────────────────

const recordedStreamCloseEvents = vi.hoisted((): Array<Record<string, unknown>> => []);
let mockUpstreamCreate: (() => Promise<Response>) | null = null;
let mockCodexCreate: (() => Promise<Response>) | null = null;

vi.mock("@src/proxy/codex-api.js", () => {
  class CodexApiError extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      let detail: string;
      try {
        const parsed = JSON.parse(body);
        detail = parsed.detail ?? parsed.error?.message ?? body;
      } catch {
        detail = body;
      }
      super(`Codex API error (${status}): ${detail}`);
      this.status = status;
      this.body = body;
    }
  }

  const CodexApi = vi.fn().mockImplementation(() => ({
    createResponse: vi.fn((): Promise<Response> => {
      if (mockCodexCreate) return mockCodexCreate();
      return Promise.resolve(new Response("data: {}\n\n"));
    }),
  }));

  return { CodexApi, CodexApiError };
});

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ auth: { request_interval_ms: 0 } })),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitterInt: vi.fn((val: number) => val),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@src/logs/stream-close-event.js", () => ({
  recordStreamCloseEvent: vi.fn((evt: Record<string, unknown>) => {
    recordedStreamCloseEvents.push(evt);
  }),
}));

vi.mock("@src/translation/codex-event-extractor.js", () => {
  class EmptyResponseError extends Error {
    usage: { input_tokens: number; output_tokens: number } | undefined;
    responseId: string | null;
    constructor(
      responseId: string | null = null,
      usage?: { input_tokens: number; output_tokens: number },
    ) {
      super("Codex returned an empty response");
      this.name = "EmptyResponseError";
      this.responseId = responseId;
      this.usage = usage;
    }
  }
  return { EmptyResponseError };
});

import { handleDirectRequest, handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
// Both imported — handleDirectRequest for passthrough tests, handleProxyRequest for non-passthrough verification
import { CodexApiError } from "@src/proxy/codex-api.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "gpt-4o",
      instructions: "You are helpful",
      input: [{ role: "user" as const, content: "Hello" }],
      stream: true as const,
      store: false as const,
    },
    model: "gpt-4o",
    isStreaming: false,
  };
}

function createMockUpstream(overrides?: Record<string, unknown>) {
  return {
    createResponse: vi.fn((): Promise<Response> => {
      if (mockUpstreamCreate) return mockUpstreamCreate();
      return Promise.resolve(new Response("data: {}\n\n"));
    }),
    ...overrides,
  };
}

function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@test.com" })),
    recordEmptyResponse: vi.fn(),
    hasAvailableAccounts: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({
      total: 1, active: 0, expired: 0, quota_exhausted: 0,
      rate_limited: 0, refreshing: 0, disabled: 0, banned: 0,
    })),
    ...overrides,
  };
}

// ── handleDirectRequest error forwarding ─────────────────────────────

describe("handleDirectRequest error forwarding", () => {
  beforeEach(() => {
    mockUpstreamCreate = null;
    recordedStreamCloseEvents.length = 0;
    vi.clearAllMocks();
  });

  it("forwards upstream JSON error body transparently", async () => {
    const upstreamError = {
      error: {
        message: "Invalid model: gpt-4o-nonexist",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    };
    mockUpstreamCreate = () =>
      Promise.reject(new CodexApiError(404, JSON.stringify(upstreamError)));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(404);

    const body = await res.json();
    // Should forward the original upstream error, not the proxy-wrapped version
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("model");
    expect(body.error.code).toBe("model_not_found");
    // formatError should NOT have been called
    expect(fmt.formatError).not.toHaveBeenCalled();
  });

  it("falls back to formatError for non-JSON error body", async () => {
    mockUpstreamCreate = () =>
      Promise.reject(new CodexApiError(502, "Bad Gateway"));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(fmt.formatError).toHaveBeenCalled();
  });

  it("forwards upstream 429 JSON body transparently", async () => {
    const upstreamError = {
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    };
    mockUpstreamCreate = () =>
      Promise.reject(new CodexApiError(429, JSON.stringify(upstreamError)));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(fmt.format429).not.toHaveBeenCalled();
  });

  it("falls back to format429 for non-JSON 429", async () => {
    mockUpstreamCreate = () =>
      Promise.reject(new CodexApiError(429, "Too Many Requests"));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(fmt.format429).toHaveBeenCalled();
  });

  it("forwards Anthropic-style error body", async () => {
    const anthropicError = {
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens required" },
    };
    mockUpstreamCreate = () =>
      Promise.reject(new CodexApiError(400, JSON.stringify(anthropicError)));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("uses formatError for non-CodexApiError exceptions", async () => {
    mockUpstreamCreate = () =>
      Promise.reject(new TypeError("network failure"));

    const app = new Hono();
    const upstream = createMockUpstream();
    const req = createDefaultRequest();
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(fmt.formatError).toHaveBeenCalled();
  });

  it("passes direct collect dependencies as one options object", async () => {
    const upstreamResponse = new Response("data: {}\n\n");
    mockUpstreamCreate = () => Promise.resolve(upstreamResponse);

    const app = new Hono();
    const upstream = createMockUpstream();
    const tupleSchema = { type: "array", prefixItems: [] } satisfies Record<string, unknown>;
    const req = { ...createDefaultRequest(), tupleSchema };
    const fmt = createMockFormatAdapter();

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const call = fmt.collectTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    const options = call[0] as Record<string, unknown>;
    expect(options.api).toBe(upstream);
    expect(options.response).toBe(upstreamResponse);
    expect(options.model).toBe("gpt-4o");
    expect(options.tupleSchema).toBe(tupleSchema);
    expect(options.usageHint).toBeUndefined();
    expect(options.onResponseMetadata).toBeUndefined();
  });

  it("records direct streaming failures with the direct provider and public API path", async () => {
    const upstreamResponse = new Response("data: {}\n\n");
    mockUpstreamCreate = () => Promise.resolve(upstreamResponse);

    const app = new Hono();
    const upstream = createMockUpstream({ tag: "openai" });
    const tupleSchema = { type: "array", prefixItems: [] } satisfies Record<string, unknown>;
    const req = { ...createDefaultRequest(), isStreaming: true, tupleSchema };
    const fmt = createMockFormatAdapter({
      streamTranslator: vi.fn(async function* (_options: FormatStreamTranslatorOptions) {
        throw new Error("direct stream died");
      }),
    });

    app.post("/test", (c) => handleDirectRequest({ c, upstream: upstream as never, req, fmt }));

    const res = await app.request("/test", { method: "POST" });
    await res.text();

    const call = fmt.streamTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    const options = call[0] as Record<string, unknown>;
    expect(options.api).toBe(upstream);
    expect(options.response).toBe(upstreamResponse);
    expect(options.model).toBe("gpt-4o");
    expect(typeof options.onUsage).toBe("function");
    expect(typeof options.onResponseId).toBe("function");
    expect(options.tupleSchema).toBe(tupleSchema);
    expect(options.usageHint).toBeUndefined();
    expect(options.onResponseMetadata).toBeUndefined();
    expect(options.streamContext).toMatchObject({
      tag: "Test",
      provider: "openai",
      path: "/v1/responses",
      model: "gpt-4o",
    });
    expect(recordedStreamCloseEvents).toHaveLength(1);
    expect(recordedStreamCloseEvents[0]).toMatchObject({
      kind: "upstream-error",
      provider: "openai",
      path: "/v1/responses",
      model: "gpt-4o",
      detail: "direct stream died",
    });
  });
});

// ── handleProxyRequest does NOT forward — Codex routes use proxy format ──

describe("handleProxyRequest uses proxy error format (no passthrough)", () => {
  beforeEach(() => {
    mockCodexCreate = null;
    vi.clearAllMocks();
  });

  it("wraps upstream error in proxy format, not transparent passthrough", async () => {
    const upstreamError = { detail: "Internal error" };
    mockCodexCreate = () =>
      Promise.reject(new CodexApiError(500, JSON.stringify(upstreamError)));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req = createDefaultRequest();

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest({ c, accountPool: accountPool as never, req, fmt }),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(500);

    const body = await res.json();
    // Should use proxy error format, NOT forward upstream body
    expect(body.error).toBe("api_error");
    expect(fmt.formatError).toHaveBeenCalled();
  });
});
