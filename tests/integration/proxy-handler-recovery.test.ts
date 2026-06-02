/**
 * Integration tests for proxy-handler: session recovery & defense.
 *
 * Covers previous_response_not_found recovery, unanswered function_call
 * recovery, WebSocket fallback, and ban-state pool behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WsPoolContext } from "@src/proxy/codex-api.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import type { ParsedRateLimit } from "@src/proxy/rate-limit-headers.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";
import { getSessionAffinityMap } from "@src/auth/session-affinity.js";
import { buildVariantIdentity, resolvePromptCacheIdentity } from "@src/routes/shared/proxy-session-helpers.js";
import { computeVariantHash } from "@src/routes/shared/variant-hash.js";

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
      } catch { detail = body; }
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
    constructor(responseId: string | null = null, usage?: { input_tokens: number; output_tokens: number }) {
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
      super(hadReasoning
        ? "Upstream closed stream after reasoning without producing output (likely hit response-duration cap)"
        : "Upstream closed stream without a terminal event");
      this.name = "UpstreamPrematureCloseError";
      this.responseId = responseId;
      this.hadReasoning = hadReasoning;
      this.eventCount = eventCount;
    }
  }
  return { EmptyResponseError, UpstreamPrematureCloseError };
});

import { CodexApiError, PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import { createMockAccountPool, createDefaultRequest, buildTestApp } from "./helpers/proxy-handler-fixtures.js";

describe("proxy-handler recovery & defense", () => {
  beforeEach(() => {
    mockCreateResponse = null;
    getSessionAffinityMap().dispose();
    vi.clearAllMocks();
  });

  it("recovers from previous_response_not_found by stripping ID and retrying", async () => {
    const notFoundBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68' not found.",
      },
    });

    let createCount = 0;
    const seenPrevIds: Array<string | undefined> = [];
    mockCreateResponse = () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(400, notFoundBody));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68",
      },
    };

    const origMock = mockCreateResponse;
    mockCreateResponse = () => {
      seenPrevIds.push(req.codexRequest.previous_response_id);
      return origMock!();
    };

    const { app } = buildTestApp({ accountPool, fmt, req });
    const res = await app.request("/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(createCount).toBe(2);
    expect(seenPrevIds[0]).toBe("resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68");
    expect(seenPrevIds[1]).toBeUndefined();
  });

  it("replays full original input after implicit previous-response WebSocket failure", async () => {
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        prompt_cache_key: "thread-implicit-ws",
        input: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue" },
        ],
        turnState: "turn-original",
        useWebSocket: false,
      },
    };
    const affinityMap = getSessionAffinityMap();
    const promptCacheIdentity = resolvePromptCacheIdentity(req.codexRequest, req.clientConversationId);
    const variantHash = computeVariantHash(
      req.codexRequest.instructions,
      req.codexRequest.tools,
      buildVariantIdentity(req.codexRequest, promptCacheIdentity),
    );
    affinityMap.record(
      "resp_implicit_ws",
      "e1",
      "thread-implicit-ws",
      "turn-implicit",
      "You are helpful",
      undefined,
      undefined,
      variantHash,
    );

    const seenRequests: Array<{
      input: CodexResponsesRequest["input"];
      previousResponseId: string | undefined;
      turnState: string | undefined;
      useWebSocket: boolean | undefined;
    }> = [];
    let createCount = 0;
    mockCreateResponse = (request) => {
      createCount++;
      seenRequests.push({
        input: [...request.input],
        previousResponseId: request.previous_response_id,
        turnState: request.turnState,
        useWebSocket: request.useWebSocket,
      });
      if (createCount === 1) {
        return Promise.reject(new PreviousResponseWebSocketError("ws down"));
      }
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(seenRequests).toEqual([
      {
        input: [{ role: "user", content: "continue" }],
        previousResponseId: "resp_implicit_ws",
        turnState: "turn-implicit",
        useWebSocket: true,
      },
      {
        input: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue" },
        ],
        previousResponseId: undefined,
        turnState: "turn-original",
        useWebSocket: false,
      },
    ]);
    expect(accountPool.acquire).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it("recovers when collectTranslator raises previous_response_not_found", async () => {
    const notFoundBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_collect_stale' not found.",
      },
    });
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_collect_stale",
      },
    };
    let createCount = 0;
    const seenPrevIds: Array<string | undefined> = [];
    mockCreateResponse = () => {
      createCount++;
      seenPrevIds.push(req.codexRequest.previous_response_id);
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let collectCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCount++;
        if (collectCount === 1) {
          throw new CodexApiError(400, notFoundBody);
        }
        return {
          response: { id: "resp_after_collect_retry", choices: [] },
          usage: { input_tokens: 7, output_tokens: 3 },
          responseId: "resp_after_collect_retry",
        };
      }),
    });
    const accountPool = createMockAccountPool();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(createCount).toBe(2);
    expect(collectCount).toBe(2);
    expect(seenPrevIds[0]).toBe("resp_collect_stale");
    expect(seenPrevIds[1]).toBeUndefined();
    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 7,
      output_tokens: 3,
    });
  });

  it("does not loop forever when previous_response_not_found persists after strip", async () => {
    const notFoundBody = JSON.stringify({
      error: { type: "invalid_request_error", code: "previous_response_not_found",
        message: "Previous response with id 'resp_xxx' not found." },
    });
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      return Promise.reject(new CodexApiError(400, notFoundBody));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_xxx",
      },
    };
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(400);
    expect(createCount).toBe(2);
  });

  it("recovers from unanswered function_call by stripping ID and retrying", async () => {
    const unansweredBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "No tool output found for function call call_8vO7oqvintBWH5bAoAz3vPh5.",
      },
    });

    let createCount = 0;
    const seenPrevIds: Array<string | undefined> = [];
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_unanswered_chain",
      },
    };
    mockCreateResponse = () => {
      seenPrevIds.push(req.codexRequest.previous_response_id);
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(400, unansweredBody));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt, req });
    const res = await app.request("/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(createCount).toBe(2);
    expect(seenPrevIds[0]).toBe("resp_unanswered_chain");
    expect(seenPrevIds[1]).toBeUndefined();
  });

  it("returns descriptive error when banned and remaining accounts disabled/expired", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '{"detail": "Account suspended"}'));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" }),
      hasAvailableAccounts: vi.fn(() => false),
      getPoolSummary: vi.fn(() => ({
        total: 3, active: 0, expired: 1, quota_exhausted: 0,
        rate_limited: 0, refreshing: 0, disabled: 1, banned: 1,
      })),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.message).toContain("All accounts exhausted");
    expect(body.message).toContain("1 expired");
    expect(body.message).toContain("1 disabled");
    expect(body.message).toContain("1 banned");
  });
});
