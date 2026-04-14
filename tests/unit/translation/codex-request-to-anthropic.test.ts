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
  });

  it("has max_tokens set", () => {
    const req = makeBaseRequest({ input: [{ role: "user", content: "hi" }] });
    const result = translateCodexToAnthropicRequest(req, "claude-3-5-haiku-20241022");
    expect(result.max_tokens).toBeGreaterThan(0);
  });
});
