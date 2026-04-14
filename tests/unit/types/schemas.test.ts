import { describe, it, expect } from "vitest";
import { AnthropicMessagesRequestSchema } from "@src/types/anthropic.js";
import { GeminiGenerateContentRequestSchema } from "@src/types/gemini.js";

describe("AnthropicMessagesRequestSchema", () => {
  it("parses a valid minimal request", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(false);
    }
  });

  it("parses request with stream: true", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
    }
  });

  it("rejects missing max_tokens", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty messages", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("parses thinking enabled config", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Think" }],
      thinking: { type: "enabled", budget_tokens: 5000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking?.type).toBe("enabled");
    }
  });

  it("parses thinking disabled config", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Quick" }],
      thinking: { type: "disabled" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking?.type).toBe("disabled");
    }
  });

  it("parses thinking adaptive config with budget", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Adaptive" }],
      thinking: { type: "adaptive", budget_tokens: 10000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking?.type).toBe("adaptive");
    }
  });

  it("parses thinking adaptive config without budget", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Adaptive" }],
      thinking: { type: "adaptive" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid thinking type", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Test" }],
      thinking: { type: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("parses request with tools", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Use tools" }],
      tools: [{
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses request with tool_choice auto", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Use tools" }],
      tool_choice: { type: "auto" },
    });
    expect(result.success).toBe(true);
  });

  it("parses request with string system prompt", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hello" }],
      system: "You are a helpful assistant.",
    });
    expect(result.success).toBe(true);
  });

  it("parses request with text block array system prompt", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hello" }],
      system: [{ type: "text", text: "Be concise." }],
    });
    expect(result.success).toBe(true);
  });

  it("parses multipart user content with text and image blocks", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses tool_result with image content blocks", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: [
              { type: "text", text: "Screenshot captured" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            ],
          },
        ],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses tool_result with image-only content", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_02",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "xyz" } },
            ],
          },
        ],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative max_tokens", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "gpt-5.4",
      max_tokens: -1,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("GeminiGenerateContentRequestSchema", () => {
  it("parses a valid minimal request", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty contents", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty parts", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ role: "user", parts: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("parses with systemInstruction", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Hi" }] }],
      systemInstruction: { parts: [{ text: "Be helpful" }] },
    });
    expect(result.success).toBe(true);
  });

  it("parses generationConfig with responseMimeType", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Generate JSON" }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generationConfig?.responseMimeType).toBe("application/json");
    }
  });

  it("parses generationConfig with responseSchema", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Generate JSON" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generationConfig?.responseSchema).toHaveProperty("type", "object");
    }
  });

  it("parses tools with function declarations", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Use tools" }] }],
      tools: [{
        functionDeclarations: [{
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses toolConfig with functionCallingConfig", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Use tools" }] }],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolConfig?.functionCallingConfig?.mode).toBe("AUTO");
    }
  });

  it("parses generationConfig with thinkingConfig", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Think" }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 5000 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generationConfig?.thinkingConfig?.thinkingBudget).toBe(5000);
    }
  });

  it("parses content with inline image data", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{
        role: "user",
        parts: [
          { text: "Describe this" },
          { inlineData: { mimeType: "image/png", data: "abc123" } },
        ],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses content with function call parts", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{
        role: "model",
        parts: [{
          functionCall: { name: "search", args: { q: "test" } },
        }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses content with function response parts", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{
        role: "user",
        parts: [{
          functionResponse: { name: "search", response: { result: "found" } },
        }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("parses content without explicit role", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Hello" }] }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contents[0].role).toBeUndefined();
    }
  });

  it("parses generationConfig with temperature and other fields", () => {
    const result = GeminiGenerateContentRequestSchema.safeParse({
      contents: [{ parts: [{ text: "Hi" }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 2048,
        stopSequences: ["END"],
      },
    });
    expect(result.success).toBe(true);
  });
});
