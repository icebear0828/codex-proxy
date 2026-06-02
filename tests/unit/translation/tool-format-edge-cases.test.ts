import { describe, it, expect } from "vitest";
import {
  openAIToolsToCodex,
  openAIToolChoiceToCodex,
  anthropicToolsToCodex,
  anthropicToolChoiceToCodex,
  geminiToolsToCodex,
  geminiToolConfigToCodex,
} from "@src/translation/tool-format.js";
import type { ChatCompletionRequest } from "@src/types/openai.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";
import type { GeminiGenerateContentRequest } from "@src/types/gemini.js";

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

describe("anthropicToolsToCodex Read tool pages hint", () => {
  const baseRead = {
    name: "Read",
    description: "Reads a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path" },
        pages: { type: "string", description: "Page range for PDF files." },
      },
      required: ["file_path"],
    },
  };

  it("appends omit-when-empty hint to Read tool's pages description", () => {
    const result = anthropicToolsToCodex([baseRead]);
    const params = result[0].parameters as {
      properties: { pages: { description: string } };
    };
    expect(params.properties.pages.description).toBe(
      "Page range for PDF files. Omit this field entirely for non-PDF files; do not pass an empty string.",
    );
  });

  it("is idempotent when conversion is applied twice", () => {
    const once = anthropicToolsToCodex([baseRead])[0].parameters as {
      properties: { pages: { description: string } };
    };
    const twice = anthropicToolsToCodex([
      {
        name: "Read",
        input_schema: {
          type: "object",
          properties: {
            pages: { type: "string", description: once.properties.pages.description },
          },
        },
      },
    ])[0].parameters as { properties: { pages: { description: string } } };
    expect(twice.properties.pages.description).toBe(once.properties.pages.description);
  });

  it("does not modify non-Read tools that happen to have a pages field", () => {
    const result = anthropicToolsToCodex([
      {
        name: "OtherTool",
        input_schema: {
          type: "object",
          properties: {
            pages: { type: "string", description: "Some pages thing" },
          },
        },
      },
    ]);
    const params = result[0].parameters as {
      properties: { pages: { description: string } };
    };
    expect(params.properties.pages.description).toBe("Some pages thing");
  });

  it("leaves Read tool alone when pages property is absent", () => {
    const result = anthropicToolsToCodex([
      {
        name: "Read",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ]);
    const params = result[0].parameters as {
      properties: Record<string, unknown>;
    };
    expect(params.properties).not.toHaveProperty("pages");
  });

  it("preserves other fields when augmenting", () => {
    const result = anthropicToolsToCodex([baseRead]);
    const params = result[0].parameters as {
      type: string;
      required: string[];
      properties: { file_path: { description: string }; pages: unknown };
    };
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["file_path"]);
    expect(params.properties.file_path.description).toBe("Absolute path");
  });
});

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
        strict: false,
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
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { name: "read_file", input_schema: { type: "object" } },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      { type: "function", name: "read_file", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("converts Claude Code WebSearch tool to Codex hosted web_search", () => {
    const tools = [
      {
        name: "WebSearch",
        description: "Search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
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
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools, { mapClaudeCodeWebSearch: true })).toEqual([
      {
        type: "function",
        name: "WebSearch",
        description: "Project-local lookup implementation",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });

  it("preserves a lowercase custom web_search tool as a function tool", () => {
    const tools = [
      {
        name: "web_search",
        description: "Project-local search implementation",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "web_search",
        description: "Project-local search implementation",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });

  it("preserves other Claude Code tools as function tools", () => {
    const tools = [
      {
        name: "Bash",
        description: "Run shell commands",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "Bash",
        description: "Run shell commands",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ]);
  });

  it("converts Gemini googleSearch to Codex hosted web_search", () => {
    const tools = [
      {
        googleSearch: {},
        functionDeclarations: [
          { name: "lookup", parameters: { type: "object" } },
        ],
      },
    ] satisfies NonNullable<GeminiGenerateContentRequest["tools"]>;

    expect(geminiToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      { type: "function", name: "lookup", parameters: { type: "object", properties: {} } },
    ]);
  });
});
