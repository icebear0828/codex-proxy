/**
 * Tests for translateToCodexRequest — OpenAI Chat Completions → Codex format.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.2-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/translation/shared-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/translation/shared-utils.js")>();
  return {
    buildInstructions: vi.fn((text: string) => text),
    injectAdditionalProperties: actual.injectAdditionalProperties,
    prepareSchema: actual.prepareSchema,
  };
});

vi.mock("@src/translation/tool-format.js", () => ({
  openAIToolsToCodex: vi.fn((tools: unknown[]) => tools),
  openAIToolChoiceToCodex: vi.fn(() => undefined),
  openAIFunctionsToCodex: vi.fn((fns: unknown[]) => fns),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((input: string) => {
    if (input === "codex") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: null };
    if (input === "gpt-5.4-fast") return { modelId: "gpt-5.4", serviceTier: "fast", reasoningEffort: null };
    if (input === "gpt-5.4-high") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: "high" };
    if (input === "gpt-5.4-high-fast") return { modelId: "gpt-5.4", serviceTier: "fast", reasoningEffort: "high" };
    return { modelId: input, serviceTier: null, reasoningEffort: null };
  }),
  getModelInfo: vi.fn((id: string) => {
    if (id === "gpt-5.4") return { defaultReasoningEffort: "medium" };
    return undefined;
  }),
}));

import { translateToCodexRequest as _translateToCodexRequest } from "@src/translation/openai-to-codex.js";
import type { ChatCompletionRequest } from "@src/types/openai.js";

/** Unwrap the new TranslationResult — existing tests only check codexRequest fields. */
const translateToCodexRequest = (req: ChatCompletionRequest) => _translateToCodexRequest(req).codexRequest;

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-5.4",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    n: 1,
    ...overrides,
  } as ChatCompletionRequest;
}

describe("translateToCodexRequest", () => {
  it("converts basic user message", () => {
    const result = translateToCodexRequest(makeRequest());
    expect(result.model).toBe("gpt-5.4");
    expect(result.input).toHaveLength(1);
    expect(result.input[0]).toEqual({ role: "user", content: "Hello" });
    expect(result.stream).toBe(true);
    expect(result.store).toBe(false);
  });

  it("extracts system messages as instructions", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    }));
    expect(result.instructions).toBe("You are helpful.");
    expect(result.input).toHaveLength(1);
  });

  it("combines multiple system/developer messages", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "developer", content: "Use JSON." },
        { role: "user", content: "Hi" },
      ],
    }));
    expect(result.instructions).toContain("Be concise.");
    expect(result.instructions).toContain("Use JSON.");
  });

  it("default instructions when no system messages", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [{ role: "user", content: "Hi" }],
    }));
    expect(result.instructions).toBe("You are a helpful assistant.");
  });

  it("converts assistant messages with tool_calls", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            type: "function" as const,
            function: { name: "search", arguments: '{"q":"test"}' },
          }],
        },
        { role: "tool", content: "result data", tool_call_id: "call_1" },
      ],
    }));
    const fcItem = result.input.find((i) => "type" in i && i.type === "function_call");
    expect(fcItem).toBeDefined();
    const fcOutput = result.input.find((i) => "type" in i && i.type === "function_call_output");
    expect(fcOutput).toBeDefined();
  });

  it("resolves model alias via parseModelName", () => {
    const result = translateToCodexRequest(makeRequest({ model: "codex" }));
    expect(result.model).toBe("gpt-5.4");
  });

  it("uses suffix-parsed service_tier", () => {
    const result = translateToCodexRequest(makeRequest({ model: "gpt-5.4-fast" }));
    expect(result.service_tier).toBe("fast");
  });

  it("uses suffix-parsed reasoning_effort", () => {
    const result = translateToCodexRequest(makeRequest({ model: "gpt-5.4-high" }));
    expect(result.reasoning?.effort).toBe("high");
  });

  it("explicit reasoning_effort overrides suffix", () => {
    const result = translateToCodexRequest(makeRequest({
      model: "gpt-5.4-high",
      reasoning_effort: "low",
    }));
    expect(result.reasoning?.effort).toBe("low");
  });

  it("does not set reasoning when no effort is configured or requested", () => {
    const result = translateToCodexRequest(makeRequest());
    expect(result.reasoning).toBeUndefined();
  });

  it("sets reasoning with summary: auto when effort is present", () => {
    const result = translateToCodexRequest(makeRequest({ reasoning_effort: "medium" }));
    expect(result.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("ensures at least one input item", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [{ role: "system", content: "System only" }],
    }));
    expect(result.input.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Multimodal image_url ──────────────────────────────────────────────

describe("translateToCodexRequest — multimodal content", () => {
  it("converts image_url object format to input_image part", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
        },
      ],
    }));
    const item = result.input[0];
    expect(Array.isArray(item.content)).toBe(true);
    const parts = item.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "input_text", text: "Describe this" });
    expect(parts[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,abc123" });
  });

  it("converts image_url string format to input_image part", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: "https://example.com/img.jpg" },
          ],
        },
      ],
    }));
    const item = result.input[0];
    expect(Array.isArray(item.content)).toBe(true);
    const parts = item.content as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: "input_image", image_url: "https://example.com/img.jpg" });
  });

  it("converts text-only array content to plain string", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ],
    }));
    expect(result.input[0]).toEqual({ role: "user", content: "Hello\nWorld" });
  });
});

// ── Legacy function format ────────────────────────────────────────────

describe("translateToCodexRequest — legacy function format", () => {
  it("converts assistant function_call to function_call input item", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: null,
          function_call: { name: "search", arguments: '{"q":"test"}' },
        },
      ],
    }));
    const fcItem = result.input.find((i) => "type" in i && i.type === "function_call");
    expect(fcItem).toBeDefined();
    expect(fcItem).toMatchObject({
      type: "function_call",
      call_id: "fc_search",
      name: "search",
      arguments: '{"q":"test"}',
    });
  });

  it("converts function role message to function_call_output", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: null,
          function_call: { name: "search", arguments: '{"q":"test"}' },
        },
        { role: "function", name: "search", content: "result data" },
      ],
    }));
    const fcOutput = result.input.find((i) => "type" in i && i.type === "function_call_output");
    expect(fcOutput).toBeDefined();
    expect(fcOutput).toMatchObject({
      type: "function_call_output",
      call_id: "fc_search",
      output: "result data",
    });
  });
});

// ── Response format (Structured Outputs) ──────────────────────────────

describe("translateToCodexRequest — response_format", () => {
  it("converts json_object to text.format", () => {
    const result = translateToCodexRequest(makeRequest({
      response_format: { type: "json_object" },
    }));
    expect(result.text).toEqual({ format: { type: "json_object" } });
  });

  it("converts json_schema to text.format with schema details", () => {
    const result = translateToCodexRequest(makeRequest({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "my_schema",
          schema: { type: "object", properties: { result: { type: "string" } } },
          strict: true,
        },
      },
    }));
    expect(result.text).toEqual({
      format: {
        type: "json_schema",
        name: "my_schema",
        schema: { type: "object", properties: { result: { type: "string" } }, additionalProperties: false },
        strict: true,
      },
    });
  });

  it("does not set text.format for type 'text'", () => {
    const result = translateToCodexRequest(makeRequest({
      response_format: { type: "text" },
    }));
    expect(result.text).toBeUndefined();
  });

  it("converts json_schema without strict field", () => {
    const result = translateToCodexRequest(makeRequest({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "schema_no_strict",
          schema: { type: "object" },
        },
      },
    }));
    expect(result.text?.format).toMatchObject({
      type: "json_schema",
      name: "schema_no_strict",
    });
    expect(result.text?.format).not.toHaveProperty("strict");
  });
});

// ── Branch coverage: content edge cases ───────────────────────────────

describe("translateToCodexRequest — content edge cases", () => {
  it("converts assistant message with both text and tool_calls", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: "Search and explain" },
        {
          role: "assistant",
          content: "I'll search for that.",
          tool_calls: [{
            id: "call_1",
            type: "function" as const,
            function: { name: "search", arguments: '{"q":"test"}' },
          }],
        },
      ],
    }));
    // Both text content and function_call should be in the input
    const assistantItem = result.input.find((i) => "role" in i && i.role === "assistant");
    expect(assistantItem).toBeDefined();
    expect(assistantItem!.content).toBe("I'll search for that.");
    const fcItem = result.input.find((i) => "type" in i && i.type === "function_call");
    expect(fcItem).toBeDefined();
  });

  it("skips image_url part when image_url is null/undefined", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image_url", image_url: null },
          ],
        },
      ],
    }));
    // Should not crash; the null image_url part should be skipped
    const item = result.input[0];
    if (Array.isArray(item.content)) {
      // Only text part should remain
      expect(item.content).toHaveLength(1);
      expect(item.content[0]).toEqual({ type: "input_text", text: "Describe" });
    } else {
      // Or collapsed to string if only text
      expect(typeof item.content).toBe("string");
    }
  });

  it("converts function role message without name to fc_unknown", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: "Run function" },
        {
          role: "assistant",
          content: null,
          function_call: { name: "do_thing", arguments: "{}" },
        },
        { role: "function", content: "done" }, // no name field
      ],
    }));
    const fcOutput = result.input.find(
      (i) => "type" in i && i.type === "function_call_output" && "call_id" in i && i.call_id === "fc_unknown",
    );
    expect(fcOutput).toBeDefined();
  });

  it("converts null content to empty string", () => {
    const result = translateToCodexRequest(makeRequest({
      messages: [
        { role: "user", content: null },
      ],
    }));
    // null content → extractContent returns ""
    expect(result.input[0]).toEqual({ role: "user", content: "" });
  });
});
