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
