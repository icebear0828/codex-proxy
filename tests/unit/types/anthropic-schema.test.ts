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
});
