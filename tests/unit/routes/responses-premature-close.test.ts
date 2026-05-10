/**
 * Tests that collectPassthrough handles stream interruption (premature close).
 * When the upstream stream breaks before response.completed, the collect path
 * should throw EmptyResponseError, which triggers retry in handleNonStreaming.
 */

import { describe, it, expect, vi } from "vitest";
import { EmptyResponseError } from "@src/translation/codex-event-extractor.js";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { proxy_api_key: null },
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
    auth: {
      jwt_token: undefined,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  CONFIG_DIR: "/tmp/codex-proxy-test",
  STATE_DIR: "/tmp/codex-proxy-test",
}));

import { collectPassthrough, streamPassthrough } from "@src/routes/responses.js";

interface CodexSSEEvent {
  event: string;
  data: unknown;
}

function createMockApi(events: CodexSSEEvent[], throwAfter?: Error) {
  return {
    async *parseStream(_response: Response): AsyncGenerator<CodexSSEEvent> {
      for (const evt of events) {
        yield evt;
      }
      if (throwAfter) throw throwAfter;
    },
  };
}

function parseSSEEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      const data = dataLine ? JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown> : {};
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data,
      };
    });
}

async function collectStreamEvents(events: CodexSSEEvent[], throwAfter?: Error) {
  const api = createMockApi(events, throwAfter);
  const chunks: string[] = [];
  for await (const chunk of streamPassthrough(
    api as never,
    new Response("ok"),
    "test-model",
    () => {},
    () => {},
  )) {
    chunks.push(chunk);
  }
  return parseSSEEvents(chunks.join(""));
}

describe("streamPassthrough premature close handling", () => {
  it("emits response.failed when the stream ends before response.completed", async () => {
    const events = await collectStreamEvents([
      { event: "response.created", data: { response: { id: "resp_stream_1" } } },
      { event: "response.output_text.delta", data: { delta: "partial text" } },
    ]);

    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.failed",
    ]);
    const failed = events.at(-1);
    expect(failed?.data).toMatchObject({
      type: "response.failed",
      response: {
        id: "resp_stream_1",
        status: "failed",
        error: {
          code: "stream_disconnected",
          message: "Upstream stream closed before response.completed",
        },
      },
      error: {
        code: "stream_disconnected",
        message: "Upstream stream closed before response.completed",
      },
    });
  });

  it("emits response.failed when parseStream throws before a terminal event", async () => {
    const events = await collectStreamEvents(
      [
        { event: "response.created", data: { response: { id: "resp_stream_2" } } },
      ],
      new Error("WebSocket closed unexpectedly"),
    );

    const failed = events.at(-1);
    expect(failed?.event).toBe("response.failed");
    expect(failed?.data).toMatchObject({
      response: {
        id: "resp_stream_2",
        status: "failed",
      },
      error: {
        code: "stream_disconnected",
        message: "Upstream stream closed before response.completed: WebSocket closed unexpectedly",
      },
    });
  });

  it("does not synthesize response.failed after response.completed", async () => {
    const events = await collectStreamEvents([
      { event: "response.created", data: { response: { id: "resp_stream_3" } } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_stream_3",
            output: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
      },
    ]);

    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.completed",
    ]);
  });

  it("does not synthesize response.failed after upstream response.failed", async () => {
    const events = await collectStreamEvents([
      { event: "response.created", data: { response: { id: "resp_stream_4" } } },
      {
        event: "response.failed",
        data: {
          type: "response.failed",
          response: {
            id: "resp_stream_4",
            status: "failed",
            error: { code: "upstream_error", message: "failed upstream" },
          },
        },
      },
    ]);

    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.failed",
    ]);
  });

  it("propagates local callback errors instead of synthesizing response.failed", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_callback" } } },
    ]);

    await expect((async () => {
      for await (const _chunk of streamPassthrough(
        api as never,
        new Response("ok"),
        "test-model",
        () => {},
        () => {
          throw new Error("callback broke");
        },
      )) {
        // Drain the generator.
      }
    })()).rejects.toThrow("callback broke");
  });
});

describe("collectPassthrough premature close handling", () => {
  it("throws EmptyResponseError when stream ends normally without response.completed", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      { event: "response.in_progress", data: { response: { id: "resp_1" } } },
    ]);

    await expect(collectPassthrough(api as never, new Response("ok"), "test-model")).rejects.toThrow(EmptyResponseError);
  });

  it("throws EmptyResponseError when stream throws before completion", async () => {
    const api = createMockApi(
      [
        { event: "response.created", data: { response: { id: "resp_2" } } },
        { event: "response.output_text.delta", data: { delta: "partial text" } },
      ],
      new Error("WebSocket closed unexpectedly"),
    );

    const err = await collectPassthrough(api as never, new Response("ok"), "test-model").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyResponseError);
    expect((err as EmptyResponseError).responseId).toBe("resp_2");
  });

  it("returns normally when response.completed is received", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_3" } } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_3",
            output: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
      },
    ]);

    const result = await collectPassthrough(api as never, new Response("ok"), "test-model");
    expect(result.responseId).toBe("resp_3");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("backfills completed response output from streamed web_search and message items", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_search" } } },
      {
        event: "response.output_item.done",
        data: {
          output_index: 0,
          item: {
            id: "ws_1",
            type: "web_search_call",
            status: "completed",
            actions: [{ type: "search", query: "codex proxy" }],
          },
        },
      },
      {
        event: "response.output_item.done",
        data: {
          output_index: 1,
          item: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "搜索完成" }],
          },
        },
      },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_search",
            output: [],
            usage: { input_tokens: 11, output_tokens: 22 },
          },
        },
      },
    ]);

    const result = await collectPassthrough(api as never, new Response("ok"), "test-model");
    const response = result.response as { output: unknown[]; output_text?: string };
    expect(response.output).toHaveLength(2);
    expect(response.output[0]).toMatchObject({ type: "web_search_call" });
    expect(response.output_text).toBe("搜索完成");
  });

  it("synthesizes completed response output from text deltas when output items are absent", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_delta" } } },
      { event: "response.output_text.delta", data: { delta: "搜索" } },
      { event: "response.output_text.delta", data: { delta: "完成" } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_delta",
            output: [],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        },
      },
    ]);

    const result = await collectPassthrough(api as never, new Response("ok"), "test-model");
    const response = result.response as { output: Array<{ content: Array<{ text: string }> }>; output_text?: string };
    expect(response.output[0].content[0].text).toBe("搜索完成");
    expect(response.output_text).toBe("搜索完成");
  });

  it("keeps output_text synchronized after tuple reconversion", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_tuple" } } },
      {
        event: "response.output_item.done",
        data: {
          output_index: 0,
          item: {
            id: "msg_tuple",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "{\"point\":{\"0\":42,\"1\":\"hello\"}}",
              },
            ],
          },
        },
      },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_tuple",
            output: [],
            usage: { input_tokens: 6, output_tokens: 7 },
          },
        },
      },
    ]);

    const tupleSchema = {
      type: "object",
      properties: {
        point: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
          items: false,
        },
      },
    };

    const result = await collectPassthrough(
      api as never,
      new Response("ok"),
      "test-model",
      tupleSchema,
    );
    const response = result.response as {
      output: Array<{ content: Array<{ text: string }> }>;
      output_text?: string;
    };

    expect(response.output[0].content[0].text).toBe("{\"point\":[42,\"hello\"]}");
    expect(response.output_text).toBe("{\"point\":[42,\"hello\"]}");
  });

  it("rethrows original error if response.completed was already received", async () => {
    const api = createMockApi(
      [
        {
          event: "response.completed",
          data: {
            response: {
              id: "resp_4",
              output: [],
              usage: { input_tokens: 5, output_tokens: 10 },
            },
          },
        },
      ],
      new Error("late stream error"),
    );

    await expect(
      collectPassthrough(api as never, new Response("ok"), "test-model"),
    ).rejects.toThrow("late stream error");
  });
});
