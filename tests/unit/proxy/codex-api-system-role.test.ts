import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";
import type { CodexInputItem, CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { normalizeCodexSystemRoles } from "@src/proxy/codex-input-normalizer.js";

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: () => ({ Authorization: "Bearer test-token" }),
  buildHeadersWithContentType: () => ({
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  }),
}));

vi.mock("@src/config.js", () => ({
  getConfig: () => ({ api: { base_url: "https://test.example" } }),
}));

vi.mock("@src/proxy/installation-id.js", () => ({
  getInstallationId: () => "11111111-2222-3333-4444-555555555555",
}));

const mockCreateWebSocketResponse = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: (...args: unknown[]) => mockCreateWebSocketResponse(...args),
}));

/** Wire-level items the typed union does not model (e.g. `type: "message"`). */
function wire(item: Record<string, unknown>): CodexInputItem {
  return item as unknown as CodexInputItem;
}

describe("normalizeCodexSystemRoles", () => {
  it("rewrites typed system message to developer", () => {
    const out = normalizeCodexSystemRoles([wire({ type: "message", role: "system", content: "sys" })]);
    expect(out).toEqual([{ type: "message", role: "developer", content: "sys" }]);
  });

  it("rewrites bare system message to developer", () => {
    const out = normalizeCodexSystemRoles([{ role: "system", content: "sys" }]);
    expect(out).toEqual([{ role: "developer", content: "sys" }]);
  });

  it("keeps user / assistant / developer untouched", () => {
    const input: CodexInputItem[] = [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "developer", content: "d" },
    ];
    expect(normalizeCodexSystemRoles(input)).toEqual(input);
  });

  it("preserves structured content parts", () => {
    const content = [{ type: "input_text" as const, text: "sys" }];
    const out = normalizeCodexSystemRoles([{ role: "system", content }]);
    expect(out).toEqual([{ role: "developer", content }]);
  });

  it("leaves non-message items unchanged", () => {
    const input: CodexInputItem[] = [
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "compaction", encrypted_content: "enc" },
      wire({ type: "unknown_future_item", role: "tool", x: 1 }),
    ];
    expect(normalizeCodexSystemRoles(input)).toEqual(input);
  });

  it("does not mutate the original input", () => {
    const original = { role: "system" as const, content: "sys" };
    const input: CodexInputItem[] = [original];
    const out = normalizeCodexSystemRoles(input);
    expect(original.role).toBe("system");
    expect(input[0]).toBe(original);
    expect(out).not.toBe(input);
  });

  it("returns the same array when nothing needs rewriting", () => {
    const input: CodexInputItem[] = [{ role: "user", content: "u" }];
    expect(normalizeCodexSystemRoles(input)).toBe(input);
  });
});

function makeTransport() {
  const t = {
    lastBody: null as string | null,
    post: vi.fn(async (_u: string, _h: Record<string, string>, body: string): Promise<TlsTransportResponse> => {
      t.lastBody = body;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); c.close(); } }),
        setCookieHeaders: [],
      };
    }),
    get: vi.fn(),
    isImpersonate: () => false,
  };
  return t as typeof t & TlsTransport;
}

function makeRequest(overrides?: Partial<CodexResponsesRequest>): CodexResponsesRequest {
  return {
    model: "gpt-5.5",
    instructions: "i",
    input: [
      wire({ type: "message", role: "system", content: "sys" }),
      { role: "user", content: "hi" },
    ],
    ...overrides,
  };
}

describe("CodexApi.createResponse system role normalization", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = makeTransport();
    mockCreateWebSocketResponse.mockResolvedValue(new Response("ok"));
  });

  async function createApi() {
    const { CodexApi } = await import("@src/proxy/codex-api.js");
    return new CodexApi("test-token", "acct-1", null, "e1", null, "https://test.example", transport, {
      codexFingerprintMode: "off",
    });
  }

  it("HTTP body carries developer instead of system", async () => {
    const api = await createApi();
    await api.createResponse(makeRequest());
    const body = JSON.parse(transport.lastBody ?? "{}") as { input: Array<{ role: string }> };
    expect(body.input.map((i) => i.role)).toEqual(["developer", "user"]);
  });

  it("WebSocket response.create carries developer instead of system", async () => {
    const api = await createApi();
    await api.createResponse(makeRequest({ useWebSocket: true, previous_response_id: "resp_1" }));
    const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as { input: Array<{ role: string }> };
    expect(wsRequest.input.map((i) => i.role)).toEqual(["developer", "user"]);
  });

  it("WS failure fallback to HTTP still sends developer", async () => {
    mockCreateWebSocketResponse.mockRejectedValue(new Error("ws down"));
    const api = await createApi();
    await api.createResponse(makeRequest({ useWebSocket: true }));
    const body = JSON.parse(transport.lastBody ?? "{}") as { input: Array<{ role: string }> };
    expect(body.input.map((i) => i.role)).toEqual(["developer", "user"]);
  });

  it("does not mutate the caller's request", async () => {
    const api = await createApi();
    const req = makeRequest();
    await api.createResponse(req);
    expect((req.input[0] as unknown as { role: string }).role).toBe("system");
  });

  it("normalizes compact request input too", async () => {
    const api = await createApi();
    await api.createCompactResponse({
      model: "gpt-5.5",
      instructions: "i",
      input: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    }).catch(() => undefined);
    const body = JSON.parse(transport.lastBody ?? "{}") as { input: Array<{ role: string }> };
    expect(body.input.map((i) => i.role)).toEqual(["developer", "user"]);
  });
});
