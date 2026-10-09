import { describe, it, expect } from "vitest";
import { translateCodexToAnthropicRequest } from "@src/translation/codex-request-to-anthropic.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function makeBaseRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "claude-3-5-sonnet-20241022",
    input: [],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("translateCodexToAnthropicRequest", () => {
  it("converts base64 data URI images and preserves HTTP image URLs", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "input_image", image_url: "https://example.com/image.jpg" },
    ] }] });
    const result = translateCodexToAnthropicRequest(req, req.model);
    expect(result.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "image", source: { type: "url", url: "https://example.com/image.jpg" } },
    ]);
  });

  it("converts flat Codex function tools to Anthropic input schemas", () => {
    const req = makeBaseRequest({ tools: [
      { type: "function", name: "weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true },
      { type: "function", name: "clock" },
    ] });
    expect(translateCodexToAnthropicRequest(req, req.model).tools).toEqual([
      { name: "weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
      { name: "clock", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it.each([
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    ["required", { type: "any" }],
    [{ type: "function", name: "weather" }, { type: "tool", name: "weather" }],
  ])("converts Codex tool choice %j", (tool_choice, expected) => {
    const req = makeBaseRequest({ tools: [{ type: "function", name: "weather" }], tool_choice: tool_choice as CodexResponsesRequest["tool_choice"] });
    expect(translateCodexToAnthropicRequest(req, req.model).tool_choice).toEqual(expected);
  });

  it("rejects unsupported tool types instead of silently dropping them", () => {
    const req = makeBaseRequest({ tools: [{ type: "custom", name: "shell" }] });
    expect(() => translateCodexToAnthropicRequest(req, req.model)).toThrow(
      "Anthropic upstream only supports Codex function tools",
    );
  });

  it("maps user message correctly", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: "Hello" }] });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("puts instructions in top-level system field", () => {
    const req = makeBaseRequest({
      instructions: "Be helpful.",
      input: [{ role: "user", content: "hi" }],
    });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    expect(result.system).toBe("Be helpful.");
    // System messages in input are filtered out
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("converts function_call to tool_use content block", () => {
    const req = makeBaseRequest({
      input: [
        { role: "user", content: "call fn" },
        { type: "function_call", call_id: "call_1", name: "my_tool", arguments: '{"a":1}' },
      ],
    });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const content = assistantMsg!.content as Array<{ type: string; id?: string; name?: string }>;
    expect(Array.isArray(content)).toBe(true);
    const toolUse = content.find((b) => b.type === "tool_use");
    expect(toolUse).toMatchObject({ type: "tool_use", id: "call_1", name: "my_tool" });
  });

  it("converts function_call_output to tool_result in user message", () => {
    const req = makeBaseRequest({
      input: [
        { type: "function_call", call_id: "call_2", name: "fn", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: "the result" },
      ],
    });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    const userMsg = result.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
    const toolResult = content.find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "call_2", content: "the result" });
  });

  it("maps reasoning effort to thinking.budget_tokens", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "think" }],
      reasoning: { effort: "high" },
    });
    const result = translateCodexToAnthropicRequest(req, "claude-3-7-sonnet-20250219");
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
    expect(result.max_tokens).toBeGreaterThan(result.thinking!.budget_tokens);
  });

  it("keeps thinking budget below the output cap for older Claude models", () => {
    const req = makeBaseRequest({ reasoning: { effort: "high" } });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    expect(result.max_tokens).toBe(8192);
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8191 });
  });

  it("keeps xhigh thinking below the output limit on Claude 4", () => {
    const req = makeBaseRequest({ reasoning: { effort: "xhigh" } });
    const result = translateCodexToAnthropicRequest(req, "claude-opus-4-20250514");
    expect(result.max_tokens).toBe(32768);
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
  });

  it("has max_tokens set", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: "hi" }] });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-haiku-20241022");
    expect(result.max_tokens).toBeGreaterThan(0);
  });

  it("filters out developer role and merges developer/system messages into system instructions", () => {
    const req = makeBaseRequest({
      instructions: "Be helpful.",
      input: [
        { role: "developer", content: "Follow security standards." },
        { role: "user", content: "hi" },
        { role: "system", content: "Follow formatting." },
      ],
    });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-sonnet-20241022");
    expect(result.system).toBe("Be helpful.\n\nFollow security standards.\n\nFollow formatting.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
