/**
 * Tests for parseCodexEvent — the shared event type parser.
 * Migrated from src/translation/__tests__/ with @src/ path aliases.
 */

import { describe, it, expect } from "vitest";
import { parseCodexEvent } from "@src/types/codex-events.js";
import type { CodexSSEEvent } from "@src/proxy/codex-api.js";

describe("parseCodexEvent", () => {
  it("parses response.created with id", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.created");
    if (typed.type === "response.created") {
      expect(typed.response.id).toBe("resp_abc123");
    }
  });

  it("parses response.in_progress", () => {
    const raw: CodexSSEEvent = {
      event: "response.in_progress",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.in_progress");
    if (typed.type === "response.in_progress") {
      expect(typed.response.id).toBe("resp_abc123");
    }
  });

  it("parses response.output_text.delta", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: "Hello, world!" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.delta");
    if (typed.type === "response.output_text.delta") {
      expect(typed.delta).toBe("Hello, world!");
    }
  });

  it("parses response.output_text.done", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.done",
      data: { text: "Complete response text" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.done");
    if (typed.type === "response.output_text.done") {
      expect(typed.text).toBe("Complete response text");
    }
  });

  it("parses response.completed with usage", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_abc123",
          usage: { input_tokens: 150, output_tokens: 42 },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.id).toBe("resp_abc123");
      expect(typed.response.usage).toEqual({
        input_tokens: 150,
        output_tokens: 42,
      });
    }
  });

  it("parses response.completed without usage", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.usage).toBeUndefined();
    }
  });

  it("returns unknown for unrecognized event types", () => {
    const raw: CodexSSEEvent = {
      event: "response.some_future_event",
      data: { foo: "bar" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
    if (typed.type === "unknown") {
      expect(typed.raw).toEqual({ foo: "bar" });
    }
  });

  it("returns unknown when response.created has no response object", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: "not an object",
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("returns unknown when response.created data has no response field", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: { something_else: true },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("returns unknown when delta is not a string", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: 123 },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("handles empty delta string", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: "" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.delta");
    if (typed.type === "response.output_text.delta") {
      expect(typed.delta).toBe("");
    }
  });

  it("defaults usage token counts to 0 for non-numeric values", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_1",
          usage: { input_tokens: "not a number", output_tokens: null },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
    }
  });

  it("handles null data", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: null,
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("handles array data", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: [1, 2, 3],
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });
});

// ── Reasoning summary events ─────────────────────────────────────

describe("parseCodexEvent — reasoning summary events", () => {
  it("parses reasoning_summary_text.delta", () => {
    const raw: CodexSSEEvent = {
      event: "response.reasoning_summary_text.delta",
      data: { delta: "Let me think..." },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.reasoning_summary_text.delta");
    if (typed.type === "response.reasoning_summary_text.delta") {
      expect(typed.delta).toBe("Let me think...");
    }
  });

  it("parses reasoning_summary_text.done", () => {
    const raw: CodexSSEEvent = {
      event: "response.reasoning_summary_text.done",
      data: { text: "Full reasoning" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.reasoning_summary_text.done");
    if (typed.type === "response.reasoning_summary_text.done") {
      expect(typed.text).toBe("Full reasoning");
    }
  });

  it("returns unknown for reasoning delta with non-string delta", () => {
    const raw: CodexSSEEvent = {
      event: "response.reasoning_summary_text.delta",
      data: { delta: 42 },
    };
    expect(parseCodexEvent(raw).type).toBe("unknown");
  });

  it("returns unknown for reasoning done with non-string text", () => {
    const raw: CodexSSEEvent = {
      event: "response.reasoning_summary_text.done",
      data: { text: null },
    };
    expect(parseCodexEvent(raw).type).toBe("unknown");
  });
});

// ── Function call events ─────────────────────────────────────────

describe("parseCodexEvent — function call events", () => {
  it("parses output_item.added for function_call", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_item.added",
      data: {
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search" },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_item.added");
    if (typed.type === "response.output_item.added") {
      expect(typed.item.call_id).toBe("call_1");
      expect(typed.item.name).toBe("search");
      expect(typed.outputIndex).toBe(0);
    }
  });

  it("parses output_item.added with non-function_call type as known event", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_item.added",
      data: {
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
    };
    const result = parseCodexEvent(raw);
    expect(result.type).toBe("response.output_item.added");
    if (result.type === "response.output_item.added") {
      expect(result.item.type).toBe("message");
      expect(result.item.id).toBe("msg_1");
      expect(result.item.call_id).toBeUndefined();
    }
  });

  it("parses function_call_arguments.delta with call_id", () => {
    const raw: CodexSSEEvent = {
      event: "response.function_call_arguments.delta",
      data: { delta: '{"q":', call_id: "call_1", output_index: 0 },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.function_call_arguments.delta");
    if (typed.type === "response.function_call_arguments.delta") {
      expect(typed.delta).toBe('{"q":');
      expect(typed.call_id).toBe("call_1");
    }
  });

  it("parses function_call_arguments.delta with item_id fallback", () => {
    const raw: CodexSSEEvent = {
      event: "response.function_call_arguments.delta",
      data: { delta: '"test"}', item_id: "item_1", output_index: 0 },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.function_call_arguments.delta");
    if (typed.type === "response.function_call_arguments.delta") {
      expect(typed.call_id).toBe("item_1");
    }
  });

  it("returns unknown for function_call_arguments.delta without call_id or item_id", () => {
    const raw: CodexSSEEvent = {
      event: "response.function_call_arguments.delta",
      data: { delta: "test", output_index: 0 },
    };
    expect(parseCodexEvent(raw).type).toBe("unknown");
  });

  it("parses function_call_arguments.done", () => {
    const raw: CodexSSEEvent = {
      event: "response.function_call_arguments.done",
      data: { arguments: '{"q":"test"}', call_id: "call_1", name: "search" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.function_call_arguments.done");
    if (typed.type === "response.function_call_arguments.done") {
      expect(typed.arguments).toBe('{"q":"test"}');
      expect(typed.call_id).toBe("call_1");
      expect(typed.name).toBe("search");
    }
  });

  it("parses function_call_arguments.done with item_id and no name", () => {
    const raw: CodexSSEEvent = {
      event: "response.function_call_arguments.done",
      data: { arguments: '{}', item_id: "item_1" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.function_call_arguments.done");
    if (typed.type === "response.function_call_arguments.done") {
      expect(typed.call_id).toBe("item_1");
      expect(typed.name).toBe("");
    }
  });

  it("parses output_item.done", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_item.done",
      data: {
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: '{"q":"test"}' },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_item.done");
    if (typed.type === "response.output_item.done") {
      expect(typed.item.type).toBe("function_call");
      expect(typed.item.call_id).toBe("call_1");
      expect(typed.item.name).toBe("search");
      expect(typed.item.arguments).toBe('{"q":"test"}');
    }
  });
});

// ── Error and lifecycle events ───────────────────────────────────

describe("parseCodexEvent — error and lifecycle events", () => {
  it("parses error event with nested error object", () => {
    const raw: CodexSSEEvent = {
      event: "error",
      data: { error: { type: "server_error", code: "rate_limited", message: "Too many requests" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("error");
    if (typed.type === "error") {
      expect(typed.error.type).toBe("server_error");
      expect(typed.error.code).toBe("rate_limited");
      expect(typed.error.message).toBe("Too many requests");
    }
  });

  it("parses error event with flat data (no nested error)", () => {
    const raw: CodexSSEEvent = {
      event: "error",
      data: { type: "invalid_request", code: "bad_param", message: "Invalid param" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("error");
    if (typed.type === "error") {
      expect(typed.error.message).toBe("Invalid param");
    }
  });

  it("parses error event with non-object data", () => {
    const raw: CodexSSEEvent = {
      event: "error",
      data: "string error message",
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("error");
    if (typed.type === "error") {
      expect(typed.error.message).toBe("string error message");
    }
  });

  it("parses response.failed", () => {
    const raw: CodexSSEEvent = {
      event: "response.failed",
      data: {
        response: { id: "resp_1" },
        error: { type: "server_error", code: "internal", message: "Upstream failed" },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.failed");
    if (typed.type === "response.failed") {
      expect(typed.error.message).toBe("Upstream failed");
      expect(typed.response.id).toBe("resp_1");
    }
  });

  it("parses response.incomplete", () => {
    const raw: CodexSSEEvent = {
      event: "response.incomplete",
      data: { response: { id: "resp_1" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.incomplete");
    if (typed.type === "response.incomplete") {
      expect(typed.response.id).toBe("resp_1");
    }
  });

  it("parses response.queued", () => {
    const raw: CodexSSEEvent = {
      event: "response.queued",
      data: { response: { id: "resp_1" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.queued");
    if (typed.type === "response.queued") {
      expect(typed.response.id).toBe("resp_1");
    }
  });
});

// ── Usage detail extraction ──────────────────────────────────────

describe("parseCodexEvent — usage detail extraction", () => {
  it("extracts cached_tokens from input_tokens_details", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 80 },
          },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    if (typed.type === "response.completed") {
      expect(typed.response.usage?.cached_tokens).toBe(80);
    }
  });

  it("extracts reasoning_tokens from output_tokens_details", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    if (typed.type === "response.completed") {
      expect(typed.response.usage?.reasoning_tokens).toBe(20);
    }
  });

  it("omits cached_tokens when input_tokens_details absent", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_1",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    if (typed.type === "response.completed") {
      expect(typed.response.usage?.cached_tokens).toBeUndefined();
      expect(typed.response.usage?.reasoning_tokens).toBeUndefined();
    }
  });
});

// ── iterateCodexEvents — branch coverage ──────────────────────────

import { iterateCodexEvents } from "@src/translation/codex-event-extractor.js";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import { CodexApi } from "@src/proxy/codex-api.js";
import { mockResponse, sseChunk } from "@helpers/sse.js";

describe("iterateCodexEvents — unregistered item_id fallback", () => {
  it("falls back to typed.call_id when item_id is not registered for delta", async () => {
    // Create SSE stream with a delta event but NO prior output_item.added
    const sse =
      sseChunk("response.created", { response: { id: "resp_1" } }) +
      // Skip output_item.added — go straight to delta with an unregistered call_id
      sseChunk("response.function_call_arguments.delta", {
        delta: '{"q":"test"}',
        call_id: "unregistered_id",
        output_index: 0,
      }) +
      sseChunk("response.completed", { response: { id: "resp_1" } });

    const api = new CodexApi("test-token", null);
    const response = mockResponse(sse);

    const events: ExtractedEvent[] = [];
    for await (const evt of iterateCodexEvents(api, response)) {
      events.push(evt);
    }

    // Find the delta event
    const deltaEvt = events.find((e) => e.functionCallDelta);
    expect(deltaEvt).toBeDefined();
    // callId should fall back to the raw call_id since no prior registration
    expect(deltaEvt!.functionCallDelta!.callId).toBe("unregistered_id");
  });

  it("falls back to call_id and empty name for done event without registration", async () => {
    const sse =
      sseChunk("response.created", { response: { id: "resp_1" } }) +
      sseChunk("response.function_call_arguments.done", {
        arguments: '{"result":true}',
        call_id: "orphan_call",
        // No name field
      }) +
      sseChunk("response.completed", { response: { id: "resp_1" } });

    const api = new CodexApi("test-token", null);
    const response = mockResponse(sse);

    const events: ExtractedEvent[] = [];
    for await (const evt of iterateCodexEvents(api, response)) {
      events.push(evt);
    }

    const doneEvt = events.find((e) => e.functionCallDone);
    expect(doneEvt).toBeDefined();
    expect(doneEvt!.functionCallDone!.callId).toBe("orphan_call");
    expect(doneEvt!.functionCallDone!.name).toBe("");
    expect(doneEvt!.functionCallDone!.arguments).toBe('{"result":true}');
  });

  it("extracts usage from response.incomplete event", async () => {
    const sse =
      sseChunk("response.created", { response: { id: "resp_1" } }) +
      sseChunk("response.output_text.delta", { delta: "partial" }) +
      sseChunk("response.incomplete", {
        response: {
          id: "resp_1",
          usage: { input_tokens: 100, output_tokens: 30 },
        },
      });

    const api = new CodexApi("test-token", null);
    const response = mockResponse(sse);

    const events: ExtractedEvent[] = [];
    for await (const evt of iterateCodexEvents(api, response)) {
      events.push(evt);
    }

    // Find the incomplete event
    const incompleteEvt = events.find((e) => e.usage && e.responseId === "resp_1" && e.usage.input_tokens === 100);
    expect(incompleteEvt).toBeDefined();
    expect(incompleteEvt!.usage!.input_tokens).toBe(100);
    expect(incompleteEvt!.usage!.output_tokens).toBe(30);
  });
});
