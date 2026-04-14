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
  async function createApi() {
    const { CodexApi } = await import("@src/proxy/codex-api.js");
    return new CodexApi("test-token", "acct-1", null, "e1", null, "https://test.example", transport);
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

    it("excludes turnState and service_tier from JSON body", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ turnState: "abc", service_tier: "fast" }),
      );
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.turnState).toBeUndefined();
      expect(body.service_tier).toBeUndefined();
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
    });
  });
});
