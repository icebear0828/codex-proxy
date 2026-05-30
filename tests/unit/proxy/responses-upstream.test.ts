import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildResponsesUpstreamBody,
  ResponsesUpstream,
} from "@src/proxy/responses-upstream.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function baseRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "custom:gpt-5.5",
    input: [],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("buildResponsesUpstreamBody", () => {
  it("forwards standard Responses fields and rewrites the model to the native id", () => {
    const body = buildResponsesUpstreamBody(
      baseRequest({
        instructions: "be helpful",
        tools: [{ type: "function", name: "x" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: "medium" },
      }),
      "gpt-5.5",
    );

    expect(body.model).toBe("gpt-5.5");
    expect(body.instructions).toBe("be helpful");
    expect(body.tools).toEqual([{ type: "function", name: "x" }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.input).toEqual([]);
    expect(body.stream).toBe(true);
  });

  it("is an allowlist: never leaks codex-internal / chatgpt.com-only fields", () => {
    const body = buildResponsesUpstreamBody(
      baseRequest({
        client_metadata: { foo: "bar" },
        useWebSocket: true,
        turnState: "ts",
        turnMetadata: "tm",
        betaFeatures: "bf",
        version: "1.2.3",
        includeTimingMetrics: "1",
        codexWindowId: "win",
        parentThreadId: "parent",
        previous_response_id: "resp_prev",
        // OpenAI-org-bound; must not reach a third-party /responses.
        include: ["reasoning.encrypted_content"],
      }),
      "gpt-5.5",
    );

    for (const dropped of [
      "client_metadata",
      "useWebSocket",
      "turnState",
      "turnMetadata",
      "betaFeatures",
      "version",
      "includeTimingMetrics",
      "codexWindowId",
      "parentThreadId",
      "previous_response_id",
      "include",
    ]) {
      expect(body).not.toHaveProperty(dropped);
    }
  });

  it("keeps store=false (no third-party retention) and forwards prompt_cache_key when present", () => {
    const body = buildResponsesUpstreamBody(
      baseRequest({ prompt_cache_key: "conv-uuid" }),
      "m",
    );
    expect(body.store).toBe(false);
    expect(body.prompt_cache_key).toBe("conv-uuid");

    // Absent optional fields are not emitted.
    expect(buildResponsesUpstreamBody(baseRequest(), "m")).not.toHaveProperty("prompt_cache_key");
  });

  it("normalizes service_tier 'fast' to 'priority' and drops empty tier", () => {
    expect(buildResponsesUpstreamBody(baseRequest({ service_tier: "fast" }), "m").service_tier).toBe("priority");
    expect(buildResponsesUpstreamBody(baseRequest({ service_tier: "flex" }), "m").service_tier).toBe("flex");
    expect(buildResponsesUpstreamBody(baseRequest({ service_tier: null }), "m")).not.toHaveProperty("service_tier");
  });
});

describe("ResponsesUpstream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to {baseUrl}/responses with a Bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new ResponsesUpstream("custom", "sk-test", "https://gw.example.com/v1/");
    await upstream.createResponse(baseRequest(), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers.Accept).toBe("text/event-stream");
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe("gpt-5.5");
  });

  it("throws CodexApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const upstream = new ResponsesUpstream("openai", "sk", "https://api.openai.com/v1");
    await expect(upstream.createResponse(baseRequest(), new AbortController().signal))
      .rejects.toBeInstanceOf(CodexApiError);
  });

  it("passes native Responses SSE through as CodexSSEEvent", async () => {
    const sse = [
      'event: response.created',
      'data: {"response":{"id":"resp_1"}}',
      '',
      'event: response.output_text.delta',
      'data: {"delta":"hi"}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_1"}}',
      '',
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ));

    const upstream = new ResponsesUpstream("openai", "sk", "https://api.openai.com/v1");
    const resp = await upstream.createResponse(baseRequest(), new AbortController().signal);
    const events: string[] = [];
    for await (const evt of upstream.parseStream(resp)) {
      events.push(evt.event);
    }

    expect(events).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
  });
});
