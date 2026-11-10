import { describe, it, expect } from "vitest";
import { AnthropicMessagesRequestSchema } from "@src/types/anthropic.js";

const BASE_REQUEST = {
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello" },
  ],
};

describe("AnthropicMessagesRequestSchema", () => {
  it("accepts string content", () => {
    const result = AnthropicMessagesRequestSchema.safeParse(BASE_REQUEST);
    expect(result.success).toBe(true);
  });

  it("preserves disable_parallel_tool_use on tool_choice", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    }
  });

  it("accepts known array content (text block)", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_use + tool_result multi-turn", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "run bash" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown content block types (forward-compatibility)", () => {
    // Simulate a new type like "document" sent by future Claude Code versions.
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Here is a file:" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts thinking blocks in assistant messages", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "think hard" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason...", signature: "sig" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts forward-compatible message roles", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "system", content: "You are an expert engineer." },
        { role: "developer", content: "Follow company coding standards." },
        { role: "user", content: "hello" },
        { role: "future_role", content: "new role content" },
      ],
    });
    expect(result.success).toBe(true);
  });

  // output_config.effort carries Claude Code's explicitly selected reasoning
  // effort. It must survive schema parsing (zod objects silently strip
  // undeclared fields), otherwise the user's choice is dropped before the
  // translation layer ever sees it.
  describe("output_config", () => {
    it("preserves output_config.effort instead of stripping it", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: { effort: "max" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config?.effort).toBe("max");
      }
    });

    it("accepts requests without output_config", () => {
      const result = AnthropicMessagesRequestSchema.safeParse(BASE_REQUEST);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config).toBeUndefined();
      }
    });

    it("accepts output_config without effort", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: { format: { type: "json_schema" } },
      });
      expect(result.success).toBe(true);
    });

    it("preserves undeclared subfields via passthrough (future-proofing)", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: {
          effort: "high",
          task_budget: { type: "tokens", total: 64000 },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config).toEqual({
          effort: "high",
          task_budget: { type: "tokens", total: 64000 },
        });
      }
    });
  });
});
