import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquiredAccount } from "@src/auth/types.js";
import { CodexApiError, type CodexApi, type WsPoolContext } from "@src/proxy/codex-api.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { EmptyResponseError } from "@src/translation/codex-event-extractor.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/routes/shared/proxy-handler-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/routes/shared/proxy-handler-utils.js")>();
  return {
    ...actual,
    buildCodexApi: vi.fn(),
  };
});

vi.mock("@src/routes/shared/proxy-egress-log.js", () => ({
  recordProxyEgressLog: vi.fn(),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<Response>) => fn()),
}));

const proxyHandlerUtils = await import("@src/routes/shared/proxy-handler-utils.js");
const proxyEgressLog = await import("@src/routes/shared/proxy-egress-log.js");
const retryModule = await import("@src/utils/retry.js");
const { retryNonStreamingEmptyResponse } = await import("@src/routes/shared/non-streaming-empty-response-retry.js");

const buildCodexApiMock = vi.mocked(proxyHandlerUtils.buildCodexApi);
const recordProxyEgressLogMock = vi.mocked(proxyEgressLog.recordProxyEgressLog);
const withRetryMock = vi.mocked(retryModule.withRetry);

function acquired(overrides: Partial<AcquiredAccount> = {}): AcquiredAccount {
  return {
    entryId: "entry-2",
    token: "token-2",
    accountId: "account-2",
    prevSlotMs: null,
    ...overrides,
  };
}

function makePool(acquireResult: AcquiredAccount | null = acquired()): AccountPool {
  return {
    acquire: vi.fn(() => acquireResult),
    release: vi.fn(),
    getEntry: vi.fn(() => ({ email: "old@example.test" })),
    recordEmptyResponse: vi.fn(),
  } as unknown as AccountPool;
}

function makeRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "client-model",
    isStreaming: false,
    codexRequest: {
      model: "codex-model",
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: true,
      store: false,
      useWebSocket: true,
    },
    ...overrides,
  };
}

function makeApi(createResponse: CodexApi["createResponse"]): CodexApi {
  return { createResponse } as unknown as CodexApi;
}

describe("retryNonStreamingEmptyResponse", () => {
  beforeEach(() => {
    buildCodexApiMock.mockReset();
    recordProxyEgressLogMock.mockReset();
    withRetryMock.mockClear();
  });

  it("releases the empty-response account, reacquires without exclusions, and returns the retry response", async () => {
    const pool = makePool(acquired({ entryId: "entry-2" }));
    const response = new Response("retry ok", { status: 203 });
    const createResponse = vi.fn<CodexApi["createResponse"]>(async () => response);
    const api = makeApi(createResponse);
    const request = makeRequest();
    const released = new Set<string>();
    const restoreImplicitResumeRequest = vi.fn();
    const setActiveAccount = vi.fn();
    const poolCtx: WsPoolContext = {
      poolKey: "entry-2:conv:vhash",
      entryId: "entry-2",
    } as WsPoolContext;

    buildCodexApiMock.mockReturnValue(api);

    const result = await retryNonStreamingEmptyResponse({
      accountPool: pool,
      currentEntryId: "entry-1",
      collectErr: new EmptyResponseError("resp-empty", { input_tokens: 7, output_tokens: 0 }),
      req: request,
      tag: "OpenAI",
      attempt: 1,
      maxRetries: 2,
      abortSignal: new AbortController().signal,
      released,
      requestId: "rid-123456",
      restoreImplicitResumeRequest,
      buildPoolCtx: () => poolCtx,
      setActiveAccount,
      nowMs: () => 1_000,
      logWarn: vi.fn(),
    });

    expect(result).toEqual({
      action: "retry",
      entryId: "entry-2",
      api,
      rawResponse: response,
    });
    expect(pool.recordEmptyResponse).toHaveBeenCalledWith("entry-1");
    expect(pool.release).toHaveBeenCalledWith("entry-1", { input_tokens: 7, output_tokens: 0 });
    expect(restoreImplicitResumeRequest).toHaveBeenCalledOnce();
    expect(pool.acquire).toHaveBeenCalledWith({
      model: "codex-model",
      excludeIds: undefined,
      preferredEntryId: undefined,
    });
    expect(buildCodexApiMock).toHaveBeenCalledWith("token-2", "account-2", undefined, "entry-2", undefined);
    expect(setActiveAccount).toHaveBeenCalledWith("entry-2", api);
    expect(createResponse).toHaveBeenCalledWith(request.codexRequest, expect.any(AbortSignal), undefined, poolCtx);
    expect(recordProxyEgressLogMock).toHaveBeenCalledWith({
      requestId: "rid-123456",
      request,
      status: 203,
      startMs: 1_000,
    });
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("returns a response plan without rendering when no retry account is available", async () => {
    const pool = makePool(null);
    const request = makeRequest();

    const result = await retryNonStreamingEmptyResponse({
      accountPool: pool,
      currentEntryId: "entry-1",
      collectErr: new EmptyResponseError("resp-empty", { input_tokens: 1, output_tokens: 0 }),
      req: request,
      tag: "OpenAI",
      attempt: 1,
      maxRetries: 2,
      abortSignal: new AbortController().signal,
      released: new Set<string>(),
      requestId: "rid-123456",
      nowMs: () => 1_000,
      logWarn: vi.fn(),
    });

    expect(result).toEqual({
      action: "respond",
      status: 502,
      message: "Codex returned an empty response and no other accounts are available for retry",
    });
    expect(pool.recordEmptyResponse).toHaveBeenCalledWith("entry-1");
    expect(pool.release).toHaveBeenCalledWith("entry-1", { input_tokens: 1, output_tokens: 0 });
    expect(buildCodexApiMock).not.toHaveBeenCalled();
    expect(recordProxyEgressLogMock).not.toHaveBeenCalled();
  });

  it("releases the retry account and returns a response plan when the retry request fails with CodexApiError", async () => {
    const pool = makePool(acquired({ entryId: "entry-2" }));
    const request = makeRequest();
    const err = new CodexApiError(422, "bad retry request");
    const api = makeApi(vi.fn<CodexApi["createResponse"]>(async () => {
      throw err;
    }));

    buildCodexApiMock.mockReturnValue(api);

    const result = await retryNonStreamingEmptyResponse({
      accountPool: pool,
      currentEntryId: "entry-1",
      collectErr: new EmptyResponseError("resp-empty", { input_tokens: 1, output_tokens: 0 }),
      req: request,
      tag: "OpenAI",
      attempt: 1,
      maxRetries: 2,
      abortSignal: new AbortController().signal,
      released: new Set<string>(),
      requestId: "rid-123456",
      nowMs: () => 2_000,
      logWarn: vi.fn(),
    });

    expect(result).toEqual({
      action: "respond",
      status: 422,
      message: err.message,
    });
    expect(pool.release).toHaveBeenCalledWith("entry-2", undefined);
    expect(recordProxyEgressLogMock).toHaveBeenCalledWith({
      requestId: "rid-123456",
      request,
      status: 422,
      error: err.message,
      startMs: 2_000,
    });
  });

  it("releases the retry account and rethrows non-Codex retry failures", async () => {
    const pool = makePool(acquired({ entryId: "entry-2" }));
    const request = makeRequest();
    const err = new TypeError("transport exploded");
    const api = makeApi(vi.fn<CodexApi["createResponse"]>(async () => {
      throw err;
    }));

    buildCodexApiMock.mockReturnValue(api);

    await expect(retryNonStreamingEmptyResponse({
      accountPool: pool,
      currentEntryId: "entry-1",
      collectErr: new EmptyResponseError("resp-empty", { input_tokens: 1, output_tokens: 0 }),
      req: request,
      tag: "OpenAI",
      attempt: 1,
      maxRetries: 2,
      abortSignal: new AbortController().signal,
      released: new Set<string>(),
      requestId: "rid-123456",
      nowMs: () => 3_000,
      logWarn: vi.fn(),
    })).rejects.toBe(err);

    expect(pool.release).toHaveBeenCalledWith("entry-2", undefined);
    expect(recordProxyEgressLogMock).toHaveBeenCalledWith({
      requestId: "rid-123456",
      request,
      status: null,
      error: "transport exploded",
      startMs: 3_000,
    });
  });
});
