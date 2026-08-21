import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

// Mock fingerprint — return minimal headers
vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: () => ({ Authorization: "Bearer test-token" }),
  buildHeadersWithContentType: () => ({
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  }),
}));

// Mock config
vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    api: { base_url: "https://test.example" },
  }),
}));

// Mock installation_id (deterministic value)
const mockGetInstallationId = vi.fn((_accountScope?: string | null) => "11111111-2222-3333-4444-555555555555");
vi.mock("@src/proxy/installation-id.js", () => ({
  getInstallationId: (accountScope?: string | null) => mockGetInstallationId(accountScope),
}));


// Capture createWebSocketResponse calls
const mockCreateWebSocketResponse = vi.fn<
  (...args: unknown[]) => Promise<Response>
>();
vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: (...args: unknown[]) =>
    mockCreateWebSocketResponse(...args),
}));

function makeTransport(): TlsTransport & {
  lastHeaders: Record<string, string> | null;
  lastBody: string | null;
} {
  const t = {
    lastHeaders: null as Record<string, string> | null,
    lastBody: null as string | null,
    post: vi.fn(
      async (
        _url: string,
        headers: Record<string, string>,
        body: string,
      ): Promise<TlsTransportResponse> => {
        t.lastHeaders = headers;
        t.lastBody = body;
        const encoder = new TextEncoder();
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode("data: {}\n\n"));
              c.close();
            },
          }),
          setCookieHeaders: [],
        };
      },
    ),
    get: vi.fn(),
    isImpersonate: () => false,
  };
  return t;
}

function makeRequest(overrides?: Partial<CodexResponsesRequest>): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    instructions: "test",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...overrides,
  };
}

describe("codex-api headers", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = makeTransport();
  });

  // Lazy import to let mocks register first
  async function createApi(
    entryId = "e1",
    accountId = "acct-1",
    fingerprintMode: "off" | "session" = "off",
  ) {
    const { CodexApi } = await import("@src/proxy/codex-api.js");
    return new CodexApi(
      "test-token",
      accountId,
      null,
      entryId,
      null,
      "https://test.example",
      transport,
      { codexFingerprintMode: fingerprintMode },
    );
  }

  describe("HTTP SSE path", () => {
    it("sends x-openai-internal-codex-residency: us", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-openai-internal-codex-residency"]).toBe("us");
    });

    it("sends x-client-request-id in UUID format", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("sends x-codex-turn-state when turnState is present", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ turnState: "abc123" }));
      expect(transport.lastHeaders!["x-codex-turn-state"]).toBe("abc123");
    });

    it("omits x-codex-turn-state when turnState is absent", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-codex-turn-state"]).toBeUndefined();
    });

    it("excludes turnState from JSON body and maps fast service_tier to priority", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ turnState: "abc", service_tier: "fast" }),
      );
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.turnState).toBeUndefined();
      expect(body.service_tier).toBe("priority");
    });

    it("preserves non-fast service_tier in JSON body", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ service_tier: "flex" }));
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.service_tier).toBe("flex");
    });

    it("sends x-codex-installation-id header and inside body.client_metadata", async () => {
      const api = await createApi("entry-acc-99", "acct-99");
      await api.createResponse(makeRequest());
      expect(mockGetInstallationId).toHaveBeenCalledWith("entry-acc-99");
      expect(transport.lastHeaders!["x-codex-installation-id"]).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });


    it("preserves caller-provided client_metadata fields and only injects installation id", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ client_metadata: { "x-custom": "v1" } }),
      );
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-custom": "v1",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("sends x-openai-subagent header for review requests", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ client_metadata: { "x-openai-subagent": "review" } }),
      );

      expect(transport.lastHeaders!["x-openai-subagent"]).toBe("review");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata["x-openai-subagent"]).toBe("review");
    });

    it("derives a stable account-scoped upstream identity from prompt_cache_key", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ prompt_cache_key: "thread-123" }));

      const firstIdentity = transport.lastHeaders!["x-client-request-id"];
      expect(firstIdentity).toMatch(/^cp_[0-9a-f]{32}$/);
      expect(firstIdentity).not.toBe("thread-123");
      expect(transport.lastHeaders!["session_id"]).toBe(firstIdentity);
      expect(transport.lastHeaders!["x-codex-window-id"]).toBe(`${firstIdentity}:0`);
      const firstBody = JSON.parse(transport.lastBody!) as {
        prompt_cache_key: string;
        client_metadata: Record<string, string>;
      };
      expect(firstBody.prompt_cache_key).toBe(firstIdentity);
      expect(firstBody.client_metadata["session_id"]).toBe(firstIdentity);
      expect(firstBody.client_metadata["x-codex-window-id"]).toBe(`${firstIdentity}:0`);

      await api.createResponse(makeRequest({ prompt_cache_key: "thread-123" }));
      expect(transport.lastHeaders!["x-client-request-id"]).toBe(firstIdentity);

      const otherAccountApi = await createApi("e2", "acct-2");
      await otherAccountApi.createResponse(makeRequest({ prompt_cache_key: "thread-123" }));
      expect(transport.lastHeaders!["x-client-request-id"]).toMatch(/^cp_[0-9a-f]{32}$/);
      expect(transport.lastHeaders!["x-client-request-id"]).not.toBe(firstIdentity);
    });

    it("converges only session_id when the account explicitly opts in", async () => {
      const api = await createApi("e1", "acct-1", "session");
      const turnMetadata = JSON.stringify({ session_id: "client-session", sandbox: "seatbelt" });
      await api.createResponse(makeRequest({ prompt_cache_key: "thread-a", turnMetadata }));

      const firstHeaders = { ...transport.lastHeaders! };
      const firstBody = JSON.parse(transport.lastBody!) as {
        prompt_cache_key: string;
        client_metadata: Record<string, string>;
      };
      await api.createResponse(makeRequest({ prompt_cache_key: "thread-b" }));
      const secondBody = JSON.parse(transport.lastBody!) as {
        prompt_cache_key: string;
        client_metadata: Record<string, string>;
      };

      expect(firstHeaders.session_id).toMatch(/^cs_[0-9a-f]{32}$/);
      expect(transport.lastHeaders!.session_id).toBe(firstHeaders.session_id);
      expect(firstHeaders["x-client-request-id"]).not.toBe(transport.lastHeaders!["x-client-request-id"]);
      expect(firstBody.prompt_cache_key).not.toBe(secondBody.prompt_cache_key);
      expect(firstBody.client_metadata.session_id).toBe(firstHeaders.session_id);
      expect(secondBody.client_metadata.session_id).toBe(firstHeaders.session_id);
      expect(firstHeaders["x-codex-installation-id"]).toBe("11111111-2222-3333-4444-555555555555");
      expect(firstHeaders["x-codex-turn-metadata"]).toBe(turnMetadata);

      const otherAccountApi = await createApi("e2", "acct-2", "session");
      await otherAccountApi.createResponse(makeRequest({ prompt_cache_key: "thread-c" }));
      expect(transport.lastHeaders!.session_id).toMatch(/^cs_[0-9a-f]{32}$/);
      expect(transport.lastHeaders!.session_id).not.toBe(firstHeaders.session_id);
    });

    it("maps explicit Codex window ids before upstream forwarding", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({
        prompt_cache_key: "thread-123",
        codexWindowId: "thread-123:1",
      }));

      expect(transport.lastHeaders!["x-codex-window-id"]).toMatch(/^cw_[0-9a-f]{32}$/);
      expect(transport.lastHeaders!["x-codex-window-id"]).not.toBe("thread-123:1");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata["x-codex-window-id"]).toBe(transport.lastHeaders!["x-codex-window-id"]);
    });

    it("forwards Codex review context headers and metadata", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({
        turnMetadata: "{\"thread_source\":\"subagent\"}",
        betaFeatures: "feature-a",
        includeTimingMetrics: "true",
        version: "26.318.11754",
        codexWindowId: "thread-123:1",
        parentThreadId: "parent-123",
      }));

      expect(transport.lastHeaders!["x-codex-turn-metadata"]).toBe("{\"thread_source\":\"subagent\"}");
      expect(transport.lastHeaders!["x-codex-beta-features"]).toBe("feature-a");
      expect(transport.lastHeaders!["x-responsesapi-include-timing-metrics"]).toBe("true");
      expect(transport.lastHeaders!["Version"]).toBe("26.318.11754");
      expect(transport.lastHeaders!["x-codex-window-id"]).toMatch(/^cw_[0-9a-f]{32}$/);
      expect(transport.lastHeaders!["x-codex-window-id"]).not.toBe("thread-123:1");
      expect(transport.lastHeaders!["x-codex-parent-thread-id"]).toBe("parent-123");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-codex-turn-metadata": "{\"thread_source\":\"subagent\"}",
        "x-codex-window-id": transport.lastHeaders!["x-codex-window-id"],
        "x-codex-parent-thread-id": "parent-123",
      });
    });
  });

  describe("WebSocket path", () => {
    it("sends residency, request-id, and turn-state headers", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          previous_response_id: "resp_prev",
          useWebSocket: true,
          turnState: "ws_turn_abc",
        }),
      );

      expect(mockCreateWebSocketResponse).toHaveBeenCalledTimes(1);
      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-openai-internal-codex-residency"]).toBe("us");
      expect(headers["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(headers["x-codex-turn-state"]).toBe("ws_turn_abc");
      expect(headers["x-codex-installation-id"]).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata).toMatchObject({
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("preserves review subagent metadata on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          client_metadata: { "x-openai-subagent": "review" },
        }),
      );

      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-openai-subagent"]).toBe("review");
      expect(wsRequest.client_metadata).toMatchObject({
        "x-openai-subagent": "review",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("maps fast service_tier to priority on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          service_tier: "fast",
        }),
      );

      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        service_tier?: string;
      };
      expect(wsRequest.service_tier).toBe("priority");
    });

    it("derives a stable account-scoped WebSocket identity from prompt_cache_key", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          prompt_cache_key: "thread-456",
        }),
      );

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      const firstIdentity = headers["x-client-request-id"];
      expect(firstIdentity).toMatch(/^cp_[0-9a-f]{32}$/);
      expect(firstIdentity).not.toBe("thread-456");
      expect(headers["session_id"]).toBe(firstIdentity);
      expect(headers["x-codex-window-id"]).toBe(`${firstIdentity}:0`);
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        prompt_cache_key?: string;
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.prompt_cache_key).toBe(firstIdentity);
      expect(wsRequest.client_metadata?.["x-codex-window-id"]).toBe(`${firstIdentity}:0`);

      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          prompt_cache_key: "thread-456",
        }),
      );
      const secondHeaders = mockCreateWebSocketResponse.mock.calls[1][1] as Record<string, string>;
      expect(secondHeaders["x-client-request-id"]).toBe(firstIdentity);

      const otherAccountApi = await createApi("e2", "acct-2");
      await otherAccountApi.createResponse(
        makeRequest({
          useWebSocket: true,
          prompt_cache_key: "thread-456",
        }),
      );
      const otherHeaders = mockCreateWebSocketResponse.mock.calls[2][1] as Record<string, string>;
      expect(otherHeaders["x-client-request-id"]).toMatch(/^cp_[0-9a-f]{32}$/);
      expect(otherHeaders["x-client-request-id"]).not.toBe(firstIdentity);
    });

    it("uses one opt-in session_id across WebSocket conversations without merging cache keys", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );
      const api = await createApi("e1", "acct-1", "session");

      await api.createResponse(makeRequest({ useWebSocket: true, prompt_cache_key: "thread-a" }));
      await api.createResponse(makeRequest({ useWebSocket: true, prompt_cache_key: "thread-b" }));

      const firstHeaders = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      const secondHeaders = mockCreateWebSocketResponse.mock.calls[1][1] as Record<string, string>;
      const firstRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        prompt_cache_key?: string;
        client_metadata?: Record<string, string>;
      };
      const secondRequest = mockCreateWebSocketResponse.mock.calls[1][2] as {
        prompt_cache_key?: string;
        client_metadata?: Record<string, string>;
      };

      expect(firstHeaders.session_id).toMatch(/^cs_[0-9a-f]{32}$/);
      expect(secondHeaders.session_id).toBe(firstHeaders.session_id);
      expect(firstHeaders["x-client-request-id"]).not.toBe(secondHeaders["x-client-request-id"]);
      expect(firstRequest.prompt_cache_key).not.toBe(secondRequest.prompt_cache_key);
      expect(firstRequest.client_metadata?.session_id).toBe(firstHeaders.session_id);
      expect(secondRequest.client_metadata?.session_id).toBe(firstHeaders.session_id);
    });

    it("maps explicit Codex window ids on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          prompt_cache_key: "thread-456",
          codexWindowId: "thread-456:1",
        }),
      );

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-codex-window-id"]).toMatch(/^cw_[0-9a-f]{32}$/);
      expect(headers["x-codex-window-id"]).not.toBe("thread-456:1");
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata?.["x-codex-window-id"]).toBe(headers["x-codex-window-id"]);
    });

    it("forwards Codex review context on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          turnMetadata: "{\"thread_source\":\"subagent\"}",
          betaFeatures: "feature-a",
          includeTimingMetrics: "true",
          version: "26.318.11754",
          codexWindowId: "thread-456:1",
          parentThreadId: "parent-456",
        }),
      );

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-codex-turn-metadata"]).toBe("{\"thread_source\":\"subagent\"}");
      expect(headers["x-codex-beta-features"]).toBe("feature-a");
      expect(headers["x-responsesapi-include-timing-metrics"]).toBe("true");
      expect(headers["Version"]).toBe("26.318.11754");
      expect(headers["x-codex-window-id"]).toMatch(/^cw_[0-9a-f]{32}$/);
      expect(headers["x-codex-window-id"]).not.toBe("thread-456:1");
      expect(headers["x-codex-parent-thread-id"]).toBe("parent-456");
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata).toMatchObject({
        "x-codex-turn-metadata": "{\"thread_source\":\"subagent\"}",
        "x-codex-window-id": headers["x-codex-window-id"],
        "x-codex-parent-thread-id": "parent-456",
      });
    });

    it("previous_response_id 场景下 WebSocket 失败不会降级成 HTTP delta-only", async () => {
      const { PreviousResponseWebSocketError } = await import("@src/proxy/codex-api.js");
      mockCreateWebSocketResponse.mockRejectedValue(new Error("ws down"));

      const api = await createApi();
      await expect(api.createResponse(
        makeRequest({
          previous_response_id: "resp_prev",
          useWebSocket: true,
          input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
        }),
      )).rejects.toBeInstanceOf(PreviousResponseWebSocketError);

      expect(transport.post).not.toHaveBeenCalled();
    });

    it("没有 previous_response_id 时 WebSocket 失败仍可安全降级到 HTTP", async () => {
      mockCreateWebSocketResponse.mockRejectedValue(new Error("ws down"));

      const api = await createApi();
      await api.createResponse(makeRequest({ useWebSocket: true }));

      expect(transport.post).toHaveBeenCalledOnce();
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.previous_response_id).toBeUndefined();
      expect(body.useWebSocket).toBeUndefined();
    });

    it("WS 上游返回的 CodexApiError 不能降级到 HTTP（必须抛给 proxy-handler 轮转）", async () => {
      // Without re-throwing, the same account would just retry over HTTP and
      // hit the same usage_limit_reached, never rotating.
      const { CodexApiError } = await import("@src/proxy/codex-api.js");
      mockCreateWebSocketResponse.mockRejectedValue(
        new CodexApiError(429, JSON.stringify({
          type: "error",
          error: { code: "usage_limit_reached", message: "Limit reached" },
        })),
      );

      const api = await createApi();
      await expect(
        api.createResponse(makeRequest({ useWebSocket: true })),
      ).rejects.toBeInstanceOf(CodexApiError);

      expect(transport.post).not.toHaveBeenCalled();
    });

    it("sends account-scoped x-codex-installation-id on createCompactResponse", async () => {
      const api = await createApi("entry-compact-1", "acct-compact-1");
      const encoder = new TextEncoder();
      transport.post = vi.fn(async (_url: string, headers: Record<string, string>) => {
        transport.lastHeaders = headers;
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          body: new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(JSON.stringify({ status: "completed", output: [] })));
              c.close();
            },
          }),
          setCookieHeaders: [],
        };
      });

      await api.createCompactResponse({
        model: "gpt-5.4",
        input: [{ type: "message", role: "user", content: "test" }],
      });

      expect(mockGetInstallationId).toHaveBeenCalledWith("entry-compact-1");
      expect(transport.lastHeaders!["x-codex-installation-id"]).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
    });
  });
});

