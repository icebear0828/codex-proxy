import { describe, it, expect } from "vitest";
import { parseCodexEvent } from "@src/types/codex-events.js";
import type { CodexSSEEvent } from "@src/proxy/codex-api.js";

function makeRaw(event: string, data: unknown): CodexSSEEvent {
  return { event, data };
}

describe("parseCodexEvent — message output_item.added", () => {
  it("parses output_item.added with item.type=message as known event", () => {
    const raw = makeRaw("response.output_item.added", {
      type: "response.output_item.added",
      item: {
        id: "msg_abc",
        type: "message",
        status: "in_progress",
        content: [],
        role: "assistant",
      },
      output_index: 0,
      sequence_number: 2,
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.output_item.added");
    expect(result.type).not.toBe("unknown");
  });

  it("still parses output_item.added with item.type=function_call", () => {
    const raw = makeRaw("response.output_item.added", {
      type: "response.output_item.added",
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
      },
      output_index: 0,
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.output_item.added");
    if (result.type === "response.output_item.added") {
      expect(result.item.type).toBe("function_call");
      expect(result.item.call_id).toBe("call_1");
      expect(result.item.name).toBe("get_weather");
    }
  });
});

describe("parseCodexEvent — content_part events", () => {
  it("parses response.content_part.added as known event", () => {
    const raw = makeRaw("response.content_part.added", {
      type: "response.content_part.added",
      content_index: 0,
      item_id: "msg_abc",
      output_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" },
      sequence_number: 3,
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.content_part.added");
  });

  it("parses response.content_part.done as known event", () => {
    const raw = makeRaw("response.content_part.done", {
      type: "response.content_part.done",
      content_index: 0,
      item_id: "msg_abc",
      output_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "Hello world" },
      sequence_number: 4,
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.content_part.done");
  });
});

describe("parseCodexEvent — error events", () => {
  it("extracts response.failed errors from response.error", () => {
    const raw = makeRaw("response.failed", {
      type: "response.failed",
      response: {
        id: "resp_1",
        error: {
          code: "server_error",
          message: "upstream failed",
        },
      },
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.failed");
    if (result.type === "response.failed") {
      expect(result.error.code).toBe("server_error");
      expect(result.error.message).toBe("upstream failed");
      expect(result.response.id).toBe("resp_1");
    }
  });

  it("marks partial JSON error payloads as malformed", () => {
    const raw = makeRaw("error", "{");
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error.code).toBe("malformed_error_event");
      expect(result.error.message).toBe("{");
    }
  });
});

describe("parseCodexEvent — tool_usage.image_gen extraction", () => {
  it("extracts image_input_tokens / image_output_tokens from response.completed", () => {
    const raw = makeRaw("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 1200, output_tokens: 30 },
        tool_usage: {
          image_gen: {
            input_tokens: 31,
            input_tokens_details: { image_tokens: 0, text_tokens: 31 },
            output_tokens: 196,
            output_tokens_details: { image_tokens: 196, text_tokens: 0 },
            total_tokens: 227,
          },
          web_search: { num_requests: 0 },
        },
      },
    });
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.completed");
    if (result.type === "response.completed") {
      expect(result.response.usage?.input_tokens).toBe(1200);
      expect(result.response.usage?.output_tokens).toBe(30);
      expect(result.response.usage?.image_input_tokens).toBe(31);
      expect(result.response.usage?.image_output_tokens).toBe(196);
    }
  });

  it("omits image fields when both image_gen counts are zero (no image generated)", () => {
    const raw = makeRaw("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 20 },
        tool_usage: {
          image_gen: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    });
    const result = parseCodexEvent(raw);
    if (result.type === "response.completed") {
      expect(result.response.usage?.image_input_tokens).toBeUndefined();
      expect(result.response.usage?.image_output_tokens).toBeUndefined();
    }
  });

  it("omits image fields entirely when tool_usage is missing", () => {
    const raw = makeRaw("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    const result = parseCodexEvent(raw);
    if (result.type === "response.completed") {
      expect(result.response.usage?.image_input_tokens).toBeUndefined();
      expect(result.response.usage?.image_output_tokens).toBeUndefined();
    }
  });

  it("ignores non-numeric image_gen token values", () => {
    const raw = makeRaw("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 20 },
        tool_usage: {
          image_gen: { input_tokens: "31", output_tokens: null },
        },
      },
    });
    const result = parseCodexEvent(raw);
    if (result.type === "response.completed") {
      expect(result.response.usage?.image_input_tokens).toBeUndefined();
      expect(result.response.usage?.image_output_tokens).toBeUndefined();
    }
  });

  it("populates image fields even when host-model usage is absent", () => {
    // Defensive: if upstream emits image_gen without a top-level usage block,
    // we still surface image tokens (with input/output zeroed for host model).
    const raw = makeRaw("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        tool_usage: {
          image_gen: { input_tokens: 31, output_tokens: 196 },
        },
      },
    });
    const result = parseCodexEvent(raw);
    if (result.type === "response.completed") {
      expect(result.response.usage?.input_tokens).toBe(0);
      expect(result.response.usage?.output_tokens).toBe(0);
      expect(result.response.usage?.image_input_tokens).toBe(31);
      expect(result.response.usage?.image_output_tokens).toBe(196);
    }
  });
});
