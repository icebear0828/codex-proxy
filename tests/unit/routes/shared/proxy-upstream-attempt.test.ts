import { CodexApiError } from "@src/proxy/codex-api.js";
import {
  sendProxyUpstreamAttempt,
  type ProxyUpstreamAttemptApi,
} from "@src/routes/shared/proxy-upstream-attempt.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import type { RateLimitAccountPool } from "@src/routes/shared/proxy-rate-limit.js";
import type { ParsedRateLimit } from "@src/proxy/rate-limit-headers.js";
import { WsConnectionPool } from "@src/proxy/ws-pool.js";
import type { WsPoolContext } from "@src/proxy/codex-api.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/routes/shared/proxy-debug-dump.js", () => ({
  dumpProxyRequest: vi.fn(),
}));

vi.mock("@src/routes/shared/proxy-egress-log.js", () => ({
  recordProxyEgressLog: vi.fn(),
}));

const { dumpProxyRequest } = await import("@src/routes/shared/proxy-debug-dump.js");
const { recordProxyEgressLog } = await import("@src/routes/shared/proxy-egress-log.js");

function makeProxyRequest(): ProxyRequest {
  return {
    model: "gpt-5.4",
    isStreaming: true,
    codexRequest: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: true,
      store: false,
      prompt_cache_key: "conv-1",
      useWebSocket: true,
    },
  };
}

function makeAccountPool(): RateLimitAccountPool {
  return {
    getEntry: vi.fn(() => ({ planType: "team" })),
    updateCachedQuota: vi.fn(),
    syncRateLimitWindow: vi.fn(),
    applyRateLimit429: vi.fn(),
  };
}

function makeApi(response: Response): ProxyUpstreamAttemptApi {
  return {
    createResponse: vi.fn(async () => response),
  };
}

describe("sendProxyUpstreamAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dumps the outbound request, sends it with retry wrapper inputs, and records egress", async () => {
    const request = makeProxyRequest();
    const response = new Response("ok", {
      status: 202,
      headers: {
        "x-codex-turn-state": "turn-upstream",
      },
    });
    const api = makeApi(response);
    const abortController = new AbortController();
    const poolCtx: WsPoolContext = {
      pool: new WsConnectionPool({ enabled: false }, { startGc: false }),
      poolKey: "entry-1:conv-1:vh",
      entryId: "entry-1",
    };

    const result = await sendProxyUpstreamAttempt({
      accountPool: makeAccountPool(),
      api,
      request,
      entryId: "entry-1",
      abortSignal: abortController.signal,
      buildPoolCtx: () => poolCtx,
      requestId: "request-123456",
      tag: "Chat",
      conversationId: "conv-1",
      implicitResumeActive: true,
      resumeReason: null,
      nowMs: () => 1_000,
      retryOptions: { maxRetries: 0, baseDelayMs: 1 },
    });

    expect(result).toEqual({
      rawResponse: response,
      upstreamTurnState: "turn-upstream",
    });
    expect(dumpProxyRequest).toHaveBeenCalledWith({
      requestId: "request-123456",
      tag: "Chat",
      entryId: "entry-1",
      conversationId: "conv-1",
      implicitResumeActive: true,
      resumeReason: null,
      payload: request.codexRequest,
    });
    expect(api.createResponse).toHaveBeenCalledTimes(1);
    const createResponseCall = vi.mocked(api.createResponse).mock.calls[0]!;
    expect(createResponseCall[0]).toBe(request.codexRequest);
    expect(createResponseCall[1]).toBe(abortController.signal);
    expect(createResponseCall[2]).toBeTypeOf("function");
    expect(createResponseCall[3]).toBe(poolCtx);
    expect(recordProxyEgressLog).toHaveBeenCalledWith({
      requestId: "request-123456",
      request,
      status: 202,
      startMs: 1_000,
    });
  });

  it("applies HTTP response rate-limit headers to the active entry", async () => {
    const pool = makeAccountPool();
    const response = new Response("ok", {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "60",
        "x-codex-primary-reset-at": "2000000300",
      },
    });

    await sendProxyUpstreamAttempt({
      accountPool: pool,
      api: makeApi(response),
      request: makeProxyRequest(),
      entryId: "entry-rate",
      abortSignal: new AbortController().signal,
      buildPoolCtx: () => undefined,
      requestId: "request-123456",
      tag: "Chat",
      conversationId: "conv-1",
      implicitResumeActive: false,
      resumeReason: "no-prev",
      nowMs: () => 1_000,
      retryOptions: { maxRetries: 0, baseDelayMs: 1 },
    });

    expect(pool.updateCachedQuota).toHaveBeenCalledWith("entry-rate", expect.objectContaining({
      rate_limit: expect.objectContaining({ used_percent: 100, limit_reached: true }),
    }));
    expect(pool.syncRateLimitWindow).toHaveBeenCalledWith("entry-rate", 2_000_000_300, 3_600);
    expect(pool.applyRateLimit429).toHaveBeenCalledWith("entry-rate", { resetsAtSec: 2_000_000_300 });
  });

  it("applies WebSocket rate-limit callback updates to the active entry", async () => {
    const pool = makeAccountPool();
    const parsedRateLimit: ParsedRateLimit = {
      primary: { used_percent: 42, window_minutes: 300, reset_at: 1_700_000_300 },
      secondary: null,
      code_review: null,
    };
    const api: ProxyUpstreamAttemptApi = {
      createResponse: vi.fn(async (_request, _signal, onRateLimits) => {
        onRateLimits?.(parsedRateLimit);
        return new Response("ok", { status: 200 });
      }),
    };

    await sendProxyUpstreamAttempt({
      accountPool: pool,
      api,
      request: makeProxyRequest(),
      entryId: "entry-ws",
      abortSignal: new AbortController().signal,
      buildPoolCtx: () => undefined,
      requestId: "request-123456",
      tag: "Chat",
      conversationId: "conv-1",
      implicitResumeActive: false,
      resumeReason: "no-prev",
      nowMs: () => 1_000,
      retryOptions: { maxRetries: 0, baseDelayMs: 1 },
    });

    expect(pool.updateCachedQuota).toHaveBeenCalledWith("entry-ws", expect.objectContaining({
      rate_limit: expect.objectContaining({ used_percent: 42 }),
    }));
  });

  it("retries retryable upstream errors before recording successful egress once", async () => {
    const response = new Response("ok", { status: 200 });
    const api: ProxyUpstreamAttemptApi = {
      createResponse: vi
        .fn()
        .mockRejectedValueOnce(new CodexApiError(500, "temporary"))
        .mockResolvedValueOnce(response),
    };

    const result = await sendProxyUpstreamAttempt({
      accountPool: makeAccountPool(),
      api,
      request: makeProxyRequest(),
      entryId: "entry-retry",
      abortSignal: new AbortController().signal,
      buildPoolCtx: () => undefined,
      requestId: "request-123456",
      tag: "Chat",
      conversationId: "conv-1",
      implicitResumeActive: false,
      resumeReason: "no-prev",
      nowMs: () => 1_000,
      retryOptions: { maxRetries: 1, baseDelayMs: 1 },
    });

    expect(result.rawResponse).toBe(response);
    expect(api.createResponse).toHaveBeenCalledTimes(2);
    expect(recordProxyEgressLog).toHaveBeenCalledTimes(1);
  });

  it("passes terminal Codex API errors to the outer handler without recording success egress", async () => {
    const err = new CodexApiError(400, "bad request");
    const api: ProxyUpstreamAttemptApi = {
      createResponse: vi.fn(async () => {
        throw err;
      }),
    };

    await expect(sendProxyUpstreamAttempt({
      accountPool: makeAccountPool(),
      api,
      request: makeProxyRequest(),
      entryId: "entry-error",
      abortSignal: new AbortController().signal,
      buildPoolCtx: () => undefined,
      requestId: "request-123456",
      tag: "Chat",
      conversationId: "conv-1",
      implicitResumeActive: false,
      resumeReason: "no-prev",
      retryOptions: { maxRetries: 1, baseDelayMs: 1 },
    })).rejects.toBe(err);

    expect(api.createResponse).toHaveBeenCalledTimes(1);
    expect(recordProxyEgressLog).not.toHaveBeenCalled();
  });
});
