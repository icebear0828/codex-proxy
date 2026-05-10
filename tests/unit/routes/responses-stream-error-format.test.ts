import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = {
  server: {
    proxy_api_key: null as string | null,
    trust_proxy: false,
  },
  model: {
    default: "gpt-5.3-codex",
    default_reasoning_effort: null as string | null,
    default_service_tier: null as string | null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
    request_interval_ms: 0,
  },
  logs: {
    capture_body: false,
  },
};

let mockCreateResponse: (() => Promise<Response>) | null = null;

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/logs/entry.js", () => ({
  enqueueLogEntry: vi.fn(),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@src/proxy/codex-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/proxy/codex-api.js")>();
  return {
    ...actual,
    CodexApi: vi.fn().mockImplementation(() => ({
      tag: "codex",
      createResponse: vi.fn((): Promise<Response> => {
        if (mockCreateResponse) return mockCreateResponse();
        return Promise.resolve(new Response("data: {}\n\n"));
      }),
      parseStream: vi.fn(async function* () {
        yield { event: "response.completed", data: { response: { id: "resp_ok" } } };
      }),
    })),
  };
});

import { CodexApiError } from "@src/proxy/codex-api.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

function createMockAccountPool() {
  return {
    isAuthenticated: vi.fn(() => true),
    validateProxyApiKey: vi.fn(() => true),
    acquire: vi.fn(() => ({
      entryId: "entry_1",
      token: "token_1",
      accountId: "acct_1",
      prevSlotMs: null,
    })),
    release: vi.fn(),
    getEntry: vi.fn(() => ({
      email: "test@example.com",
      planType: null,
      cachedQuota: null,
    })),
    updateCachedQuota: vi.fn(),
    syncRateLimitWindow: vi.fn(),
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    hasAvailableAccounts: vi.fn(() => false),
    getPoolSummary: vi.fn(() => ({
      total: 1,
      active: 0,
      expired: 0,
      quota_exhausted: 0,
      rate_limited: 0,
      refreshing: 0,
      disabled: 0,
      banned: 0,
    })),
    recordEmptyResponse: vi.fn(),
  };
}

function parseFirstSSEEvent(text: string): { event: string; data: unknown } {
  const block = text.trim().split("\n\n").find(Boolean);
  if (!block) throw new Error("No SSE event found");

  const lines = block.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");

  return {
    event: eventLine?.slice("event: ".length) ?? "",
    data: JSON.parse(data) as unknown,
  };
}

describe("/v1/responses stream error formatting", () => {
  beforeEach(() => {
    mockCreateResponse = null;
    vi.clearAllMocks();
  });

  it("emits upstream_transport_error when the upstream request fails before SSE starts", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(0, "error sending request for url"));

    const accountPool = createMockAccountPool();
    const app = createResponsesRoutes(accountPool as never);

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
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const event = parseFirstSSEEvent(await res.text());
    expect(event.event).toBe("response.failed");
    expect(event.data).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          type: "server_error",
          code: "upstream_transport_error",
          message: "error sending request for url",
        },
      },
      error: {
        type: "server_error",
        code: "upstream_transport_error",
        message: "error sending request for url",
      },
    });
    expect(accountPool.release).toHaveBeenCalledWith("entry_1", undefined);
  });
});
