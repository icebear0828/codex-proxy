/**
 * Integration tests for proxy-handler.
 *
 * Uses a real Hono app to exercise handleProxyRequest end-to-end,
 * avoiding the need to manually mock Hono Context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { FormatCollectTranslatorOptions, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import type { WsPoolContext } from "@src/proxy/codex-api.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import type { ParsedRateLimit } from "@src/proxy/rate-limit-headers.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";
import { getSessionAffinityMap } from "@src/auth/session-affinity.js";
import { buildVariantIdentity, resolvePromptCacheIdentity } from "@src/routes/shared/proxy-session-helpers.js";
import { computeVariantHash } from "@src/routes/shared/variant-hash.js";

// ── Module-level control for CodexApi.createResponse ──────────────────

type MockCreateResponse = (
  request: CodexResponsesRequest,
  signal?: AbortSignal,
  onRateLimits?: (rateLimits: ParsedRateLimit) => void,
  poolCtx?: WsPoolContext,
) => Promise<Response>;

let mockCreateResponse: MockCreateResponse | null = null;

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

  class PreviousResponseWebSocketError extends CodexApiError {
    causeMessage: string;
    constructor(causeMessage: string) {
      super(0, JSON.stringify({
        error: {
          message:
            "WebSocket failed while using previous_response_id; HTTP SSE fallback would drop server-side history: " +
            causeMessage,
        },
      }));
      this.name = "PreviousResponseWebSocketError";
      this.causeMessage = causeMessage;
    }
  }

  const CodexApi = vi.fn().mockImplementation(() => ({
    createResponse: vi.fn((
      request: CodexResponsesRequest,
      signal?: AbortSignal,
      onRateLimits?: (rateLimits: ParsedRateLimit) => void,
      poolCtx?: WsPoolContext,
    ): Promise<Response> => {
      if (mockCreateResponse) return mockCreateResponse(request, signal, onRateLimits, poolCtx);
      return Promise.resolve(new Response("data: {}\n\n"));
    }),
  }));

  return { CodexApi, CodexApiError, PreviousResponseWebSocketError };
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
  class UpstreamPrematureCloseError extends Error {
    responseId: string | null;
    hadReasoning: boolean;
    eventCount: number;
    constructor(responseId: string | null, hadReasoning: boolean, eventCount: number) {
      super(
        hadReasoning
          ? "Upstream closed stream after reasoning without producing output (likely hit response-duration cap)"
          : "Upstream closed stream without a terminal event",
      );
      this.name = "UpstreamPrematureCloseError";
      this.responseId = responseId;
      this.hadReasoning = hadReasoning;
      this.eventCount = eventCount;
    }
  }
  return { EmptyResponseError, UpstreamPrematureCloseError };
});

// Import after mocks are set up
import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { CodexApiError, PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import { EmptyResponseError, UpstreamPrematureCloseError } from "@src/translation/codex-event-extractor.js";

// ── Helpers ───────────────────────────────────────────────────────────

function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    applyRateLimit429: vi.fn(),
    updateCachedQuota: vi.fn(),
    syncRateLimitWindow: vi.fn(),
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

function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user" as const, content: "Hello" }],
      stream: true as const,
      store: false as const,
    },
    model: "codex",
    isStreaming: false,
  };
}

function createStreamingRequest(): ProxyRequest {
  return { ...createDefaultRequest(), isStreaming: true };
}

/**
 * Build a Hono app that forwards POST /test to handleProxyRequest.
 * Returns the app and the mocks for assertion.
 */
function buildTestApp(opts: {
  accountPool?: ReturnType<typeof createMockAccountPool>;
  fmt?: ReturnType<typeof createMockFormatAdapter>;
  req?: ProxyRequest;
  cookieJar?: unknown;
}) {
  const accountPool = opts.accountPool ?? createMockAccountPool();
  const fmt = opts.fmt ?? createMockFormatAdapter();
  const proxyReq = opts.req ?? createDefaultRequest();
  const cookieJar = opts.cookieJar ?? undefined;

  const app = new Hono();
  app.post("/test", (c) =>
    handleProxyRequest({
      c,
      accountPool: accountPool as never,
      cookieJar,
      req: proxyReq,
      fmt,
    }),
  );

  return { app, accountPool, fmt, proxyReq };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("proxy-handler integration", () => {
  beforeEach(() => {
    mockCreateResponse = null;
    getSessionAffinityMap().dispose();
    vi.clearAllMocks();
  });

  // 1. No account available
  it("returns noAccountStatus (503) when no account is available", async () => {
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toEqual({ error: "no_account" });
    expect(fmt.formatNoAccount).toHaveBeenCalled();
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 2. Non-streaming success
  it("returns JSON result from collectTranslator for non-streaming", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const tupleSchema = { type: "array", prefixItems: [] } satisfies Record<string, unknown>;
    const req = { ...createDefaultRequest(), tupleSchema };
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ id: "resp_1", choices: [] });
    expect(fmt.collectTranslator).toHaveBeenCalled();
    const call = fmt.collectTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    const options = call[0] as Record<string, unknown>;
    expect(options.api).toBeDefined();
    expect(options.response).toBeInstanceOf(Response);
    expect(options.model).toBe("codex");
    expect(options.tupleSchema).toBe(tupleSchema);
    expect(options.usageHint).toBeUndefined();
    expect(typeof options.onResponseMetadata).toBe("function");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it("records non-streaming response affinity metadata from collectTranslator", async () => {
    mockCreateResponse = () =>
      Promise.resolve(new Response("data: {}\n\n", {
        headers: { "x-codex-turn-state": "turn-success" },
      }));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async (options: FormatCollectTranslatorOptions) => {
        options.onResponseMetadata?.({ functionCallIds: ["call_a", "call_a"] });
        options.onResponseMetadata?.({ functionCallIds: ["call_b"] });
        return {
          response: { id: "resp_meta", choices: [] },
          usage: { input_tokens: 33, output_tokens: 4 },
          responseId: "resp_meta",
        };
      }),
    });
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        prompt_cache_key: "thread-collect",
      },
    };
    const promptCacheIdentity = resolvePromptCacheIdentity(req.codexRequest, req.clientConversationId);
    const variantHash = computeVariantHash(
      req.codexRequest.instructions,
      req.codexRequest.tools,
      buildVariantIdentity(req.codexRequest, promptCacheIdentity),
    );
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const affinityMap = getSessionAffinityMap();
    expect(affinityMap.lookup("resp_meta")).toBe("e1");
    expect(affinityMap.lookupConversationId("resp_meta")).toBe("thread-collect");
    expect(affinityMap.lookupTurnState("resp_meta")).toBe("turn-success");
    expect(affinityMap.lookupInstructionsHash("resp_meta")).toBe("58d0189aa8572b25a2e4ba09928df2c3d924d07f53de9aeb94ffe7f6f2a1de2b");
    expect(affinityMap.lookupInputTokens("resp_meta")).toBe(33);
    expect(affinityMap.lookupFunctionCallIds("resp_meta")).toEqual(["call_a", "call_b"]);
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "thread-collect",
      undefined,
      variantHash,
    )).toBe("resp_meta");
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "thread-collect",
      undefined,
      "different-variant",
    )).toBeNull();
  });

  it("blocks oversized full-history replay when implicit resume is missing tool calls", async () => {
    const createSpy = vi.fn<MockCreateResponse>(async () => new Response("data: {}\n\n"));
    mockCreateResponse = createSpy;

    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        prompt_cache_key: "thread-large-missing-tools",
        input: [
          { role: "user", content: "first" },
          { type: "function_call", call_id: "call_expected", name: "read_file", arguments: "{}" },
          { type: "function_call_output", call_id: "call_missing", output: "{}" },
          ...Array.from({ length: 1010 }, (_, index) => ({
            role: "user" as const,
            content: `padding message ${index}`,
          })),
        ],
      },
    };
    const promptCacheIdentity = resolvePromptCacheIdentity(req.codexRequest, req.clientConversationId);
    const variantHash = computeVariantHash(
      req.codexRequest.instructions,
      req.codexRequest.tools,
      buildVariantIdentity(req.codexRequest, promptCacheIdentity),
    );
    getSessionAffinityMap().record(
      "resp_prev_missing_tools",
      "e1",
      "thread-large-missing-tools",
      undefined,
      "You are helpful",
      21,
      ["call_expected"],
      variantHash,
    );

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(413);
    expect(createSpy).not.toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);

    const body = await res.json();
    expect(body).toMatchObject({
      error: "api_error",
      status: 413,
    });
    expect(body.message).toContain("Implicit resume failed: missing_tool_calls");
  });

  // 3. Streaming success
  it("returns text/event-stream with SSE chunks for streaming", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const tupleSchema = { type: "array", prefixItems: [] } satisfies Record<string, unknown>;
    const req = { ...createStreamingRequest(), tupleSchema };
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: {}\n\n");
    expect(text).toContain("data: [DONE]\n\n");
    expect(fmt.streamTranslator).toHaveBeenCalled();
    const call = fmt.streamTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    const options = call[0] as Record<string, unknown>;
    expect(options.api).toBeDefined();
    expect(options.response).toBeInstanceOf(Response);
    expect(options.model).toBe("codex");
    expect(typeof options.onUsage).toBe("function");
    expect(typeof options.onResponseId).toBe("function");
    expect(options.tupleSchema).toBe(tupleSchema);
    expect(options.usageHint).toBeUndefined();
    expect(typeof options.onResponseMetadata).toBe("function");
    expect(options.streamContext).toMatchObject({
      tag: "Test",
      provider: "codex",
      path: "/codex/responses",
      model: "codex",
      accountEntryId: "e1",
    });
  });

  it("returns a streaming error event when upstream request fails before SSE starts", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(0, "error sending request for url"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain("error sending request for url");
    expect(fmt.formatStreamError).toHaveBeenCalledWith(
      502,
      "Codex API error (0): error sending request for url",
    );
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 4. CodexApiError 429 → markRateLimited with parsed retryAfterSec + fallback to next account
  it("handles 429 by parsing resets_in_seconds and falling back to next account", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", message: "Limit reached", resets_in_seconds: 471284 },
    });
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(429, body429));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e1", {
      retryAfterSec: 471284,
      countRequest: true,
    });
    // Second account succeeds — release called with usage
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it("attributes WebSocket rate-limit callback updates to the failed account before fallback", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", message: "Limit reached", resets_in_seconds: 123 },
    });
    const parsedRateLimit: ParsedRateLimit = {
      primary: { used_percent: 100, window_minutes: 60, reset_at: 2_000_000_300 },
      secondary: null,
      code_review: null,
    };
    let createCount = 0;
    mockCreateResponse = (_request, _signal, onRateLimits) => {
      createCount++;
      if (createCount === 1) {
        onRateLimits?.(parsedRateLimit);
        return Promise.reject(new CodexApiError(429, body429));
      }
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.updateCachedQuota).toHaveBeenCalledTimes(1);
    expect(accountPool.updateCachedQuota).toHaveBeenCalledWith("e1", expect.objectContaining({
      rate_limit: expect.objectContaining({
        used_percent: 100,
        limit_reached: true,
      }),
    }));
    expect(accountPool.syncRateLimitWindow).toHaveBeenCalledWith("e1", 2_000_000_300, 3_600);
    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e1", { resetsAtSec: 2_000_000_300 });
    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e1", {
      retryAfterSec: 123,
      countRequest: true,
    });
    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 4b. 429 with no resets_in_seconds → retryAfterSec undefined
  it("handles 429 with plain body (no resets_in_seconds) using default backoff", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, "Rate limited"));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e1", {
      retryAfterSec: undefined,
      countRequest: true,
    });
  });

  // 4c. 429 with resets_at fallback (no resets_in_seconds)
  it("handles 429 with resets_at fallback when resets_in_seconds is absent", async () => {
    const futureResetAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", resets_at: futureResetAt },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    const call = accountPool.applyRateLimit429.mock.calls[0] as [string, { retryAfterSec: number; countRequest: boolean }];
    expect(call[0]).toBe("e1");
    // Should be approximately 3600 (±5s tolerance for test execution time)
    expect(call[1].retryAfterSec).toBeGreaterThan(3590);
    expect(call[1].retryAfterSec).toBeLessThanOrEqual(3600);
    expect(call[1].countRequest).toBe(true);
  });

  // 4d. 429 exhausts all accounts → returns 429 to client
  it("returns 429 when all accounts are rate limited", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", resets_in_seconds: 100 },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce({ entryId: "e2", token: "tok2", accountId: "acc2" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    // Both accounts marked rate limited
    expect(accountPool.applyRateLimit429).toHaveBeenCalledTimes(2);
    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e1", { retryAfterSec: 100, countRequest: true });
    expect(accountPool.applyRateLimit429).toHaveBeenCalledWith("e2", { retryAfterSec: 100, countRequest: true });
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 5. CodexApiError 4xx → formatError with status code
  it("handles 4xx CodexApiError with formatError", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(400, "Bad Request"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.status).toBe(400);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  it("releases model-not-supported account before retrying a fallback account", async () => {
    let upstreamCalls = 0;
    mockCreateResponse = () => {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return Promise.reject(new CodexApiError(400, JSON.stringify({
          error: { message: "Model gpt-5.4 is not supported on this plan" },
        })));
      }
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce({ entryId: "e2", token: "tok2", accountId: "acc2" }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.acquire).toHaveBeenNthCalledWith(1, {
      model: "codex",
      excludeIds: undefined,
      preferredEntryId: undefined,
    });
    expect(accountPool.acquire).toHaveBeenNthCalledWith(2, {
      model: "codex",
      excludeIds: ["e1"],
      preferredEntryId: undefined,
    });
    expect(accountPool.release).toHaveBeenNthCalledWith(1, "e1", undefined);
    expect(accountPool.release).toHaveBeenNthCalledWith(2, "e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 5b. CodexApiError 403 (non-CF) → marks banned, tries fallback
  it("handles 403 ban by marking banned and trying next account", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '{"detail": "Account suspended"}'));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "banned");
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 5c. CF 403 (Cloudflare challenge) → NOT treated as ban
  it("handles CF 403 as regular error, not ban", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '<!DOCTYPE html><html>cf_chl_managed</html>'));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    expect(accountPool.markStatus).not.toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 6. CodexApiError 5xx → formatError with 502
  it("handles 5xx CodexApiError with 502 status", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(500, "Internal Server Error"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 7. Non-CodexApiError → re-thrown (500)
  it("re-throws non-CodexApiError causing a 500", async () => {
    mockCreateResponse = () =>
      Promise.reject(new TypeError("unexpected failure"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    // Hono returns 500 for unhandled exceptions
    expect(res.status).toBe(500);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  it("formats non-Codex collect errors with embedded upstream HTTP status", async () => {
    const message = "collect failed after HTTP/2 503";
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new Error(message);
      }),
    });
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toEqual({
      error: "api_error",
      status: 503,
      message,
    });
    expect(fmt.formatError).toHaveBeenCalledWith(503, message);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 8b. Upstream premature close → 504, no cross-account retry
  it("fails fast with 504 on UpstreamPrematureCloseError, no retry", async () => {
    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        return { entryId: `e${acquireCount}`, token: "tok", accountId: "acc" };
      }),
    });

    let collectCallCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCallCount++;
        throw new UpstreamPrematureCloseError("resp_pc", true, 1920);
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(504);
    expect(collectCallCount).toBe(1);
    expect(acquireCount).toBe(1);
    expect(accountPool.recordEmptyResponse).not.toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 8. Empty response retry (non-streaming) → account switch, second succeeds
  it("retries with a new account on EmptyResponseError", async () => {
    let callCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return { entryId: "e1", token: "tok1", accountId: "acc1" };
        }
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });

    const successResult = {
      response: { id: "resp_2", choices: [{ text: "hi" }] },
      usage: { input_tokens: 5, output_tokens: 15 },
      responseId: "resp_2",
    };

    let collectCallCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCallCount++;
        if (collectCallCount === 1) {
          throw new EmptyResponseError(
            "resp_empty",
            { input_tokens: 1, output_tokens: 0 },
          );
        }
        return successResult;
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual(successResult.response);

    // First account released with EmptyResponseError usage, second with success usage
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 5,
      output_tokens: 15,
    });
  });

  it("attributes collect CodexApiError after EmptyResponseError retry to the new account", async () => {
    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });

    let collectCallCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCallCount++;
        if (collectCallCount === 1) {
          throw new EmptyResponseError(
            "resp_empty",
            { input_tokens: 1, output_tokens: 0 },
          );
        }
        throw new CodexApiError(422, JSON.stringify({
          error: { type: "invalid_request_error", message: "bad retry collect" },
        }));
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(422);

    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenCalledWith("e2", undefined);
  });

  // 9. Empty response retries exhausted → 502
  it("returns 502 when all empty response retries are exhausted", async () => {
    const emptyUsage = { input_tokens: 0, output_tokens: 0 };
    let acquireCount = 0;

    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        return {
          entryId: `e${acquireCount}`,
          token: `tok${acquireCount}`,
          accountId: `acc${acquireCount}`,
        };
      }),
    });

    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new EmptyResponseError("resp_e", emptyUsage);
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.message).toContain("empty responses");

    // MAX_EMPTY_RETRIES = 2, so 3 total attempts → 3 acquires (1 initial + 2 retries)
    // recordEmptyResponse called for each failed attempt
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledTimes(3);
  });

  // 10. No account for retry → 502 with specific message
  it("returns 502 when no account is available for empty-response retry", async () => {
    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) {
          return { entryId: "e1", token: "tok1", accountId: "acc1" };
        }
        return null; // No accounts for retry
      }),
    });

    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new EmptyResponseError(
          "resp_e",
          { input_tokens: 1, output_tokens: 0 },
        );
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.message).toContain("no other accounts are available");
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
  });

  // 11. Account released on success (non-streaming)
  it("releases the account with usage on non-streaming success", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 12. Account released on error (CodexApiError path — non-401/403/429)
  it("releases the account on CodexApiError (non-retryable)", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(422, "Unprocessable Entity"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 13. 401 token invalidation → marks expired, tries next account
  it("handles 401 by marking expired and trying next account", async () => {
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(401, '{"detail":"Your authentication token has been invalidated."}'));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "expired");
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 14. 401 with no fallback account → returns 401
  it("returns 401 when token invalidated and no other account available", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(401, "Unauthorized"));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(401);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "expired");
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 15. 429 with no available accounts → descriptive "all accounts exhausted" error
  it("returns descriptive error when 429 and no accounts available for retry", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", message: "Limit reached" },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" }),
      hasAvailableAccounts: vi.fn(() => false),
      getPoolSummary: vi.fn(() => ({
        total: 2, active: 0, expired: 0, quota_exhausted: 0,
        rate_limited: 2, refreshing: 0, disabled: 0, banned: 0,
      })),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    const body = await res.json();
    // format429 is used for 429 errors
    expect(fmt.format429).toHaveBeenCalled();
    const message = fmt.format429.mock.calls[0][0] as string;
    expect(message).toContain("All accounts exhausted");
    expect(message).toContain("2 rate-limited");
    expect(accountPool.acquire).toHaveBeenCalledTimes(1);
  });

});
