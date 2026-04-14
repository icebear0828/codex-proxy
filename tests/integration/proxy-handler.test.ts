/**
 * Integration tests for proxy-handler.
 *
 * Uses a real Hono app to exercise handleProxyRequest end-to-end,
 * avoiding the need to manually mock Hono Context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

// ── Module-level control for CodexApi.createResponse ──────────────────

let mockCreateResponse: (() => Promise<Response>) | null = null;

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
      if (mockCreateResponse) return mockCreateResponse();
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

// Import after mocks are set up
import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { CodexApiError } from "@src/proxy/codex-api.js";
import { EmptyResponseError } from "@src/translation/codex-event-extractor.js";

// ── Helpers ───────────────────────────────────────────────────────────

function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@test.com" })),
    recordEmptyResponse: vi.fn(),
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
    handleProxyRequest(
      c,
      accountPool as never,
      cookieJar,
      proxyReq,
      fmt,
    ),
  );

  return { app, accountPool, fmt, proxyReq };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("proxy-handler integration", () => {
  beforeEach(() => {
    mockCreateResponse = null;
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
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ id: "resp_1", choices: [] });
    expect(fmt.collectTranslator).toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 3. Streaming success
  it("returns text/event-stream with SSE chunks for streaming", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: {}\n\n");
    expect(text).toContain("data: [DONE]\n\n");
    expect(fmt.streamTranslator).toHaveBeenCalled();
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

    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", {
      retryAfterSec: 471284,
      countRequest: true,
    });
    // Second account succeeds — release called with usage
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

    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", {
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

    const call = accountPool.markRateLimited.mock.calls[0] as [string, { retryAfterSec: number; countRequest: boolean }];
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
    expect(accountPool.markRateLimited).toHaveBeenCalledTimes(2);
    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", { retryAfterSec: 100, countRequest: true });
    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e2", { retryAfterSec: 100, countRequest: true });
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
});
