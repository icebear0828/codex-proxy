import { describe, it, expect } from "vitest";
import {
  openAIToolsToCodex,
  openAIToolChoiceToCodex,
  openAIFunctionsToCodex,
  anthropicToolsToCodex,
  anthropicToolChoiceToCodex,
  geminiToolsToCodex,
  geminiToolConfigToCodex,
} from "@src/translation/tool-format.js";
import type { ChatCompletionRequest } from "@src/types/openai.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";
import type { GeminiGenerateContentRequest } from "@src/types/gemini.js";

// ── openAIToolsToCodex ──────────────────────────────────────────

describe("openAIToolsToCodex", () => {
  it("maps a single tool with all fields", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]);
    expect(result).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
  });

  it("omits description when not provided", () => {
    const result = openAIToolsToCodex([
      { type: "function", function: { name: "noop" } },
    ]);
    expect(result[0]).not.toHaveProperty("description");
    expect(result[0].name).toBe("noop");
  });

  it("omits parameters when not provided", () => {
    const result = openAIToolsToCodex([
      { type: "function", function: { name: "ping", description: "Ping" } },
    ]);
    expect(result[0]).not.toHaveProperty("parameters");
  });

  it("normalizes object schema without properties", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "empty_obj",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(result[0].parameters).toEqual({ type: "object", properties: {} });
  });

  it("does not add properties to non-object schemas", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "str_param",
          parameters: { type: "string" },
        },
      },
    ]);
    expect(result[0].parameters).toEqual({ type: "string" });
    expect(result[0].parameters).not.toHaveProperty("properties");
  });

  it("handles multiple tools", () => {
    const result = openAIToolsToCodex([
      { type: "function", function: { name: "a" } },
      { type: "function", function: { name: "b", description: "B tool" } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
    expect(result[1].description).toBe("B tool");
  });
});

// ── openAIToolChoiceToCodex ─────────────────────────────────────

describe("openAIToolChoiceToCodex", () => {
  it("returns undefined for falsy value (undefined)", () => {
    expect(openAIToolChoiceToCodex(undefined)).toBeUndefined();
  });

  it("passes through string values", () => {
    expect(openAIToolChoiceToCodex("none")).toBe("none");
    expect(openAIToolChoiceToCodex("auto")).toBe("auto");
    expect(openAIToolChoiceToCodex("required")).toBe("required");
  });

  it("converts object form to { type, name }", () => {
    const result = openAIToolChoiceToCodex({
      type: "function",
      function: { name: "my_func" },
    });
    expect(result).toEqual({ type: "function", name: "my_func" });
  });
});

// ── openAIFunctionsToCodex ──────────────────────────────────────

describe("openAIFunctionsToCodex", () => {
  it("converts a legacy function definition", () => {
    const result = openAIFunctionsToCodex([
      {
        name: "search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
    expect(result).toEqual([
      {
        type: "function",
        name: "search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
  });

  it("omits description and parameters when absent", () => {
    const result = openAIFunctionsToCodex([{ name: "bare" }]);
    expect(result[0]).toEqual({ type: "function", name: "bare" });
    expect(result[0]).not.toHaveProperty("description");
    expect(result[0]).not.toHaveProperty("parameters");
  });

  it("normalizes object schema without properties", () => {
    const result = openAIFunctionsToCodex([
      { name: "fn", parameters: { type: "object" } },
    ]);
    expect(result[0].parameters).toEqual({ type: "object", properties: {} });
  });
});

// ── anthropicToolsToCodex ───────────────────────────────────────

describe("anthropicToolsToCodex", () => {
  it("maps Anthropic tool to Codex format", () => {
    const result = anthropicToolsToCodex([
      {
        name: "calculator",
        description: "Do math",
        input_schema: {
          type: "object",
          properties: { expr: { type: "string" } },
        },
      },
    ]);
    expect(result).toEqual([
      {
        type: "function",
        name: "calculator",
        description: "Do math",
        parameters: {
          type: "object",
          properties: { expr: { type: "string" } },
        },
      },
    ]);
  });

  it("omits description when absent", () => {
    const result = anthropicToolsToCodex([{ name: "tool_a" }]);
    expect(result[0]).not.toHaveProperty("description");
  });

  it("omits parameters when input_schema is absent", () => {
    const result = anthropicToolsToCodex([{ name: "tool_b" }]);
    expect(result[0]).not.toHaveProperty("parameters");
  });

  it("normalizes object input_schema without properties", () => {
    const result = anthropicToolsToCodex([
      { name: "empty", input_schema: { type: "object" } },
    ]);
    expect(result[0].parameters).toEqual({ type: "object", properties: {} });
  });
});

// ── anthropicToolChoiceToCodex ──────────────────────────────────

describe("anthropicToolChoiceToCodex", () => {
  it("returns undefined for falsy value", () => {
    expect(anthropicToolChoiceToCodex(undefined)).toBeUndefined();
  });

  it('maps "auto" to "auto"', () => {
    expect(anthropicToolChoiceToCodex({ type: "auto" })).toBe("auto");
  });

  it('maps "any" to "required"', () => {
    expect(anthropicToolChoiceToCodex({ type: "any" })).toBe("required");
  });

  it('maps "tool" to { type, name }', () => {
    const result = anthropicToolChoiceToCodex({
      type: "tool",
      name: "my_tool",
    });
    expect(result).toEqual({ type: "function", name: "my_tool" });
  });

  it("returns undefined for unknown type", () => {
    // Force an unknown type to test the default branch
    const result = anthropicToolChoiceToCodex(
      { type: "unknown_type" } as Parameters<typeof anthropicToolChoiceToCodex>[0],
    );
    expect(result).toBeUndefined();
  });
});

// ── geminiToolsToCodex ──────────────────────────────────────────

describe("geminiToolsToCodex", () => {
  it("converts function declarations from a single tool group", () => {
    const result = geminiToolsToCodex([
      {
        functionDeclarations: [
          {
            name: "search",
            description: "Search web",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        type: "function",
        name: "search",
        description: "Search web",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    ]);
  });

  it("flattens multiple tool groups", () => {
    const result = geminiToolsToCodex([
      { functionDeclarations: [{ name: "a" }] },
      { functionDeclarations: [{ name: "b" }, { name: "c" }] },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.name)).toEqual(["a", "b", "c"]);
  });

  it("skips tool groups without functionDeclarations", () => {
    const result = geminiToolsToCodex([
      {},
      { functionDeclarations: [{ name: "only" }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("only");
  });

  it("returns empty array for tool groups with no declarations", () => {
    const result = geminiToolsToCodex([{}, {}]);
    expect(result).toEqual([]);
  });

  it("normalizes object schema without properties", () => {
    const result = geminiToolsToCodex([
      {
        functionDeclarations: [
          { name: "fn", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(result[0].parameters).toEqual({ type: "object", properties: {} });
  });

  it("omits description and parameters when absent", () => {
    const result = geminiToolsToCodex([
      { functionDeclarations: [{ name: "bare_fn" }] },
    ]);
    expect(result[0]).not.toHaveProperty("description");
    expect(result[0]).not.toHaveProperty("parameters");
  });
});

// ── geminiToolConfigToCodex ─────────────────────────────────────

describe("geminiToolConfigToCodex", () => {
  it("returns undefined for falsy config", () => {
    expect(geminiToolConfigToCodex(undefined)).toBeUndefined();
  });

  it("returns undefined when functionCallingConfig is missing", () => {
    expect(geminiToolConfigToCodex({})).toBeUndefined();
  });

  it("returns undefined when mode is missing", () => {
    expect(
      geminiToolConfigToCodex({ functionCallingConfig: {} }),
    ).toBeUndefined();
  });

  it('maps AUTO to "auto"', () => {
    expect(
      geminiToolConfigToCodex({ functionCallingConfig: { mode: "AUTO" } }),
    ).toBe("auto");
  });

  it('maps NONE to "none"', () => {
    expect(
      geminiToolConfigToCodex({ functionCallingConfig: { mode: "NONE" } }),
    ).toBe("none");
  });

  it('maps ANY to "required"', () => {
    expect(
      geminiToolConfigToCodex({ functionCallingConfig: { mode: "ANY" } }),
    ).toBe("required");
  });

  it("returns undefined for unknown mode", () => {
    const result = geminiToolConfigToCodex({
      functionCallingConfig: {
        mode: "UNKNOWN" as Parameters<typeof geminiToolConfigToCodex>[0] extends
          infer C ? C extends { functionCallingConfig: { mode: infer M } } ? M : never : never,
      },
    });
    expect(result).toBeUndefined();
  });
});

// ── normalizeSchema additional edge cases ────────────────────────────

describe("normalizeSchema edge cases (via openAIToolsToCodex)", () => {
  it("preserves existing properties on object schema", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "fn",
          parameters: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        },
      },
    ]);
    expect(result[0].parameters).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("passes through array schema unchanged", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "fn",
          parameters: { type: "array", items: { type: "string" } },
        },
      },
    ]);
    expect(result[0].parameters).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(result[0].parameters).not.toHaveProperty("properties");
  });

  it("passes through number schema unchanged", () => {
    const result = openAIToolsToCodex([
      {
        type: "function",
        function: {
          name: "fn",
          parameters: { type: "number" },
        },
      },
    ]);
    expect(result[0].parameters).toEqual({ type: "number" });
  });
});

// ── geminiToolsToCodex additional edge cases ──────────────────────────

describe("geminiToolsToCodex additional edge cases", () => {
  it("handles empty functionDeclarations array", () => {
    const result = geminiToolsToCodex([{ functionDeclarations: [] }]);
    expect(result).toEqual([]);
  });

  it("preserves description across multiple tool groups", () => {
    const result = geminiToolsToCodex([
      { functionDeclarations: [{ name: "a", description: "Tool A" }] },
      { functionDeclarations: [{ name: "b", description: "Tool B" }] },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].description).toBe("Tool A");
    expect(result[1].description).toBe("Tool B");
  });

  it("handles mixed groups — some with declarations, some without", () => {
    const result = geminiToolsToCodex([
      {},
      { functionDeclarations: [{ name: "x" }] },
      { functionDeclarations: [] },
      { functionDeclarations: [{ name: "y" }, { name: "z" }] },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.name)).toEqual(["x", "y", "z"]);
  });
});

// ── anthropicToolsToCodex additional edge cases ───────────────────────

describe("anthropicToolsToCodex additional edge cases", () => {
  it("handles multiple Anthropic tools", () => {
    const result = anthropicToolsToCodex([
      { name: "tool_a", description: "A" },
      { name: "tool_b", description: "B", input_schema: { type: "object", properties: {} } },
      { name: "tool_c" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "function", name: "tool_a", description: "A" });
    expect(result[1].parameters).toEqual({ type: "object", properties: {} });
    expect(result[2]).toEqual({ type: "function", name: "tool_c" });
  });

  it("normalizes nested object schemas in Anthropic tools", () => {
    const result = anthropicToolsToCodex([
      {
        name: "fn",
        input_schema: { type: "object" },
      },
    ]);
    expect(result[0].parameters).toEqual({ type: "object", properties: {} });
  });
});
// ── hosted web_search tool conversion ───────────────────────────────

describe("hosted web_search tool conversion", () => {
  it("converts OpenAI hosted web_search_preview to Codex hosted web_search", () => {
    const tools = [
      {
        type: "web_search_preview",
        search_context_size: "high",
        user_location: { type: "approximate", country: "US" },
      },
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object" },
        },
      },
    ] satisfies NonNullable<ChatCompletionRequest["tools"]>;

    expect(openAIToolsToCodex(tools)).toEqual([
      {
        type: "web_search",
        search_context_size: "high",
        user_location: { type: "approximate", country: "US" },
      },
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("converts OpenAI hosted web_search tool_choice", () => {
    expect(openAIToolChoiceToCodex({ type: "web_search_preview" })).toEqual({
      type: "web_search",
    });
  });

  it("converts Anthropic Claude Code WebSearch tool_choice to hosted web_search", () => {
    expect(
      anthropicToolChoiceToCodex(
        { type: "tool", name: "WebSearch" },
        undefined,
        { mapClaudeCodeWebSearch: true },
      ),
    ).toEqual({ type: "web_search" });
  });

  it("converts Anthropic hosted web_search tool_choice to hosted web_search", () => {
    expect(
      anthropicToolChoiceToCodex(
        { type: "tool", name: "web_search" },
        [{ type: "web_search_20250305", name: "web_search" }],
      ),
    ).toEqual({ type: "web_search" });
  });

  it("preserves Anthropic lowercase custom web_search tool_choice as function tool", () => {
    expect(
      anthropicToolChoiceToCodex(
        { type: "tool", name: "web_search" },
        [
          {
            name: "web_search",
            description: "Project-local search implementation",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      ),
    ).toEqual({ type: "function", name: "web_search" });
  });

  it("preserves Anthropic custom tool_choice as function tool", () => {
    expect(anthropicToolChoiceToCodex({ type: "tool", name: "lookup" })).toEqual({
      type: "function",
      name: "lookup",
    });
  });

  it("preserves uppercase custom WebSearch tool_choice as function tool", () => {
    const tools = [
      {
        name: "WebSearch",
        description: "Project-local lookup implementation",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(
      anthropicToolChoiceToCodex(
        { type: "tool", name: "WebSearch" },
        tools,
        { mapClaudeCodeWebSearch: true },
      ),
    ).toEqual({ type: "function", name: "WebSearch" });
  });

  it("converts Anthropic hosted web search to Codex hosted web_search", () => {
    const tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      },
      {
        name: "read_file",
        input_schema: { type: "object" },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("converts Claude Code WebSearch tool to Codex hosted web_search", () => {
    const tools = [
      {
        name: "WebSearch",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools, { mapClaudeCodeWebSearch: true })).toEqual([
      { type: "web_search" },
    ]);
  });

  it("preserves uppercase custom WebSearch tool as a function tool", () => {
    const tools = [
      {
        name: "WebSearch",
        description: "Project-local lookup implementation",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools, { mapClaudeCodeWebSearch: true })).toEqual([
      {
        type: "function",
        name: "WebSearch",
        description: "Project-local lookup implementation",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
  });

  it("preserves a lowercase custom web_search tool as a function tool", () => {
    const tools = [
      {
        name: "web_search",
        description: "Project-local search implementation",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "web_search",
        description: "Project-local search implementation",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
  });

  it("preserves other Claude Code tools as function tools", () => {
    const tools = [
      {
        name: "Bash",
        description: "Run shell commands",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "Bash",
        description: "Run shell commands",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    ]);
  });

  it("converts Gemini googleSearch to Codex hosted web_search", () => {
    const tools = [
      {
        googleSearch: {},
        functionDeclarations: [
          {
            name: "lookup",
            parameters: { type: "object" },
          },
        ],
      },
    ] satisfies NonNullable<GeminiGenerateContentRequest["tools"]>;

    expect(geminiToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});
