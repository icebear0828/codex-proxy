import { describe, it, expect } from "vitest";
import { parseCodexEvent } from "../codex-events.js";
import type { CodexSSEEvent } from "../../proxy/codex-api.js";

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
