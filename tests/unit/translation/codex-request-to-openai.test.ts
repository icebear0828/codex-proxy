import { describe, it, expect } from "vitest";
import { translateCodexToOpenAIRequest } from "@src/translation/codex-request-to-openai.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function makeBaseRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gpt-4o",
    input: [],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("translateCodexToOpenAIRequest", () => {
  it("maps basic user message to messages array", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "Hello" }],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("prepends instructions as system message", () => {
    const req = makeBaseRequest({
      instructions: "You are helpful.",
      input: [{ role: "user", content: "Hi" }],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts function_call to assistant tool_calls", () => {
    const req = makeBaseRequest({
      input: [
        { role: "user", content: "Call the function" },
        {
          type: "function_call",
          call_id: "call_123",
          name: "my_func",
          arguments: '{"x":1}',
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.tool_calls).toHaveLength(1);
    expect(assistantMsg?.tool_calls![0]).toMatchObject({
      id: "call_123",
      type: "function",
      function: { name: "my_func", arguments: '{"x":1}' },
    });
  });

  it("converts function_call_output to tool role message", () => {
    const req = makeBaseRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_abc",
          name: "fn",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: "result data",
        },
      ],
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("call_abc");
    expect(toolMsg?.content).toBe("result data");
  });

  it("adds stream_options.include_usage when streaming", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: "hi" }] });
    const streaming = translateCodexToOpenAIRequest(req, "gpt-4o", true);
    expect(streaming.stream_options).toEqual({ include_usage: true });

    const nonStreaming = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(nonStreaming.stream_options).toBeUndefined();
  });

  it("maps reasoning.effort to reasoning_effort", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "think" }],
      reasoning: { effort: "high" },
    });
    const result = translateCodexToOpenAIRequest(req, "o3", false);
    expect(result.reasoning_effort).toBe("high");
  });

  it("maps Responses tools and named choice to Chat Completions envelopes", () => {
    const tools = [{ type: "function", name: "fn", description: "Lookup", parameters: { type: "object", properties: {} }, strict: true }];
    const req = makeBaseRequest({
      input: [{ role: "user", content: "use tool" }],
      tools,
      tool_choice: { type: "function", name: "fn" },
      parallel_tool_calls: false,
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.tools).toEqual([{ type: "function", function: {
      name: "fn", description: "Lookup", parameters: { type: "object", properties: {} }, strict: true,
    } }]);
    expect(result.tool_choice).toEqual({ type: "function", function: { name: "fn" } });
    expect(result.parallel_tool_calls).toBe(false);
  });

  it("preserves custom tool calls and matching results across turns", () => {
    const req = makeBaseRequest({
      input: [
        { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "ls" },
        { type: "custom_tool_call_output", call_id: "call_custom", output: "file.txt" },
      ],
      tools: [{ type: "custom", name: "shell", format: { type: "text" } }],
      tool_choice: { type: "custom", name: "shell" },
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.tools).toEqual([{ type: "custom", name: "shell", format: { type: "text" } }]);
    expect(result.tool_choice).toEqual({ type: "custom", name: "shell" });
    expect(result.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_custom", type: "custom", custom: { name: "shell", input: "ls" } }] },
      { role: "tool", tool_call_id: "call_custom", content: "file.txt" },
    ]);
  });

  it("maps hosted web search to Chat Completions web_search_options", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "auto",
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o-search-preview", false);
    expect(result.tools).toBeUndefined();
    expect(result.web_search_options).toEqual({ search_context_size: "low" });
  });

  it("rejects Responses tools with no Chat Completions equivalent", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "draw" }],
      tools: [{ type: "image_generation" }],
    });
    expect(() => translateCodexToOpenAIRequest(req, "gpt-4o", false)).toThrow(/Unsupported Chat Completions tool type/);
  });

  it("translates developer role to system to support providers that reject developer role", () => {
    const req = makeBaseRequest({
      input: [{ role: "developer" as const, content: "You are an AI." }],
    });
    const result = translateCodexToOpenAIRequest(req, "deepseek-v4-flash", false);
    expect(result.messages[0]).toEqual({ role: "system", content: "You are an AI." });
  });

  it("maps text.format to response_format", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "json" }],
      text: { format: { type: "json_object" } },
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  it("nests Responses JSON schema inside Chat Completions response_format", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "json" }],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
    });
    const result = translateCodexToOpenAIRequest(req, "gpt-4o", false);
    expect(result.response_format).toEqual({
      type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  });
});
