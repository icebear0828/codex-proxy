import { describe, it, expect } from "vitest";
import { ChatCompletionRequestSchema } from "@src/types/openai.js";

describe("ChatCompletionRequestSchema", () => {
  it("parses a valid minimal request", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(false);
      expect(result.data.n).toBe(1);
    }
  });

  it("parses request with stream: true", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "codex",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
    }
  });

  it("rejects empty messages", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing model", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("parses request with tools", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a location",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      }],
    });
    expect(result.success).toBe(true);
  });

  it("normalizes flat function tools from Cursor Agent requests", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Edit src/index.ts" }],
      tools: [{
        type: "function",
        name: "edit_file",
        description: "Edit a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        strict: true,
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.[0]).toEqual({
        type: "function",
        function: {
          name: "edit_file",
          description: "Edit a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: true,
        },
      });
    }
  });

  it("normalizes named custom tools as function-compatible tools", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Apply a patch" }],
      tools: [{
        type: "custom",
        name: "apply_patch",
        description: "Apply a repository patch",
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.[0]).toEqual({
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply a repository patch",
        },
      });
    }
  });

  it("normalizes Responses-style input string into chat messages", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      input: "Hello from Responses-style input",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toEqual([
        { role: "user", content: "Hello from Responses-style input" },
      ]);
    }
  });

  it("normalizes Responses-style input items and reasoning effort", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      instructions: "Be concise.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Read package.json" }],
        },
        {
          type: "function_call",
          call_id: "call_read",
          name: "read_file",
          arguments: "{\"path\":\"package.json\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "{\"name\":\"codex-proxy\"}",
        },
      ],
      reasoning: { effort: "high" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning_effort).toBe("high");
      expect(result.data.messages).toEqual([
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Read package.json" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_read",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" },
          }],
        },
        {
          role: "tool",
          content: "{\"name\":\"codex-proxy\"}",
          tool_call_id: "call_read",
        },
      ]);
    }
  });

  it("parses native image_generation tools", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Draw a red circle." }],
      tools: [{ type: "image_generation", size: "1024x1024" }],
    });
    expect(result.success).toBe(true);
  });

  it("parses max token compatibility fields", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Write a long answer." }],
      max_tokens: 4096,
      max_completion_tokens: 8192,
      max_output_tokens: 16384,
    });
    expect(result.success).toBe(true);
  });

  it("parses request with legacy functions", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Weather?" }],
      functions: [{
        name: "get_weather",
        parameters: { type: "object" },
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses reasoning_effort", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Think hard" }],
      reasoning_effort: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning_effort).toBe("high");
    }
  });

  it("parses service_tier", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Fast" }],
      service_tier: "fast",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.service_tier).toBe("fast");
    }
  });

  it("parses multipart content", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    });
    expect(result.success).toBe(true);
  });
});
