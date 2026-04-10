/**
 * Tests for translateGeminiToCodexRequest / geminiContentsToMessages
 * — Google Gemini generateContent → Codex Responses API format.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.2-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/translation/shared-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/translation/shared-utils.js")>();
  return {
    buildInstructions: vi.fn((text: string) => text),
    budgetToEffort: vi.fn((budget: number | undefined) => {
      if (!budget || budget <= 0) return undefined;
      if (budget < 2000) return "low";
      if (budget < 8000) return "medium";
      if (budget < 20000) return "high";
      return "xhigh";
    }),
    injectAdditionalProperties: actual.injectAdditionalProperties,
    prepareSchema: actual.prepareSchema,
  };
});

vi.mock("@src/translation/tool-format.js", () => ({
  geminiToolsToCodex: vi.fn((tools: unknown[]) => []),
  geminiToolConfigToCodex: vi.fn(() => undefined),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((input: string) => {
    if (input === "codex") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: null };
    if (input === "gpt-5.4-fast") return { modelId: "gpt-5.4", serviceTier: "fast", reasoningEffort: null };
    if (input === "gpt-5.4-high") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: "high" };
    return { modelId: input, serviceTier: null, reasoningEffort: null };
  }),
  getModelInfo: vi.fn((id: string) => {
    if (id === "gpt-5.4") return { defaultReasoningEffort: "medium" };
    return undefined;
  }),
}));

import {
  translateGeminiToCodexRequest as _translateGeminiToCodexRequest,
  geminiContentsToMessages,
} from "@src/translation/gemini-to-codex.js";
import type { GeminiGenerateContentRequest } from "@src/types/gemini.js";

/** Unwrap the new GeminiTranslationResult — existing tests only check codexRequest fields. */
const translateGeminiToCodexRequest = (req: GeminiGenerateContentRequest, model: string) =>
  _translateGeminiToCodexRequest(req, model).codexRequest;
import { geminiToolsToCodex, geminiToolConfigToCodex } from "@src/translation/tool-format.js";

function makeRequest(
  overrides: Partial<GeminiGenerateContentRequest> = {},
): GeminiGenerateContentRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    ...overrides,
  } as GeminiGenerateContentRequest;
}

describe("translateGeminiToCodexRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts basic user text content", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.model).toBe("gpt-5.4");
    expect(result.input).toHaveLength(1);
    expect(result.input[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("extracts systemInstruction parts as instructions", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        systemInstruction: { parts: [{ text: "Be concise." }] },
      }),
      "gpt-5.4",
    );
    expect(result.instructions).toBe("Be concise.");
  });

  it("defaults instructions to 'You are a helpful assistant.' when no systemInstruction", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.instructions).toBe("You are a helpful assistant.");
  });

  it("maps model role to assistant", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [
          { role: "user", parts: [{ text: "Hi" }] },
          { role: "model", parts: [{ text: "Hello!" }] },
        ],
      }),
      "gpt-5.4",
    );
    expect(result.input).toHaveLength(2);
    expect(result.input[1]).toEqual({ role: "assistant", content: "Hello!" });
  });

  it("filters out thought parts from text content", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [
          {
            role: "model",
            parts: [
              { text: "thinking...", thought: true },
              { text: "Visible answer" },
            ],
          },
        ],
      }),
      "gpt-5.4",
    );
    const assistant = result.input.find(
      (i) => "role" in i && i.role === "assistant",
    );
    expect(assistant).toBeDefined();
    expect((assistant as { content: string }).content).toBe("Visible answer");
    expect((assistant as { content: string }).content).not.toContain("thinking");
  });

  it("converts inlineData to input_image content parts", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Describe this" },
              { inlineData: { mimeType: "image/png", data: "abc123" } },
            ],
          },
        ],
      }),
      "gpt-5.4",
    );
    const userItem = result.input[0];
    expect(userItem).toHaveProperty("content");
    const content = (userItem as { content: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string; image_url?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "input_text", text: "Describe this" });
    expect(parts[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,abc123",
    });
  });

  it("converts functionCall to function_call with generated call_id", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "search", args: { q: "test" } } },
            ],
          },
        ],
      }),
      "gpt-5.4",
    );
    const fcItem = result.input.find(
      (i) => "type" in i && i.type === "function_call",
    );
    expect(fcItem).toBeDefined();
    expect(fcItem).toMatchObject({
      type: "function_call",
      call_id: "fc_0",
      name: "search",
      arguments: '{"q":"test"}',
    });
  });

  it("converts functionResponse to function_call_output matching call_id by name", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "search", args: { q: "test" } } },
            ],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { name: "search", response: { result: "found" } } },
            ],
          },
        ],
      }),
      "gpt-5.4",
    );
    const fcItem = result.input.find(
      (i) => "type" in i && i.type === "function_call",
    );
    const fcOutput = result.input.find(
      (i) => "type" in i && i.type === "function_call_output",
    );
    expect(fcItem).toBeDefined();
    expect(fcOutput).toBeDefined();
    // The functionResponse for "search" should match the call_id from the functionCall
    expect((fcOutput as { call_id: string }).call_id).toBe(
      (fcItem as { call_id: string }).call_id,
    );
    expect(fcOutput).toMatchObject({
      type: "function_call_output",
      output: '{"result":"found"}',
    });
  });

  it("converts thinkingBudget to reasoning effort via budgetToEffort", () => {
    const result = translateGeminiToCodexRequest(
      makeRequest({
        generationConfig: {
          thinkingConfig: { thinkingBudget: 5000 },
        },
      }),
      "gpt-5.4",
    );
    expect(result.reasoning?.effort).toBe("medium");
  });

  it("maps model suffix -fast to service_tier", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4-fast");
    expect(result.service_tier).toBe("fast");
  });

  it("maps model suffix -high to reasoning effort", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4-high");
    expect(result.reasoning?.effort).toBe("high");
  });

  it("delegates tools to geminiToolsToCodex", () => {
    const tools = [
      { functionDeclarations: [{ name: "fn1", description: "desc" }] },
    ];
    translateGeminiToCodexRequest(makeRequest({ tools }), "gpt-5.4");
    expect(geminiToolsToCodex).toHaveBeenCalledWith(tools);
  });

  it("delegates toolConfig to geminiToolConfigToCodex", () => {
    const toolConfig = {
      functionCallingConfig: { mode: "AUTO" as const },
    };
    translateGeminiToCodexRequest(makeRequest({ toolConfig }), "gpt-5.4");
    expect(geminiToolConfigToCodex).toHaveBeenCalledWith(toolConfig);
  });

  it("always sets stream: true and store: false", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.stream).toBe(true);
    expect(result.store).toBe(false);
  });

  it("does not set reasoning when no effort is configured or requested", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.reasoning).toBeUndefined();
  });

  it("ensures at least one input item when contents produce no items", () => {
    // Even with empty parts, there should be at least one input
    const result = translateGeminiToCodexRequest(
      makeRequest({
        contents: [{ role: "user", parts: [{ text: "" }] }],
      }),
      "gpt-5.4",
    );
    expect(result.input.length).toBeGreaterThanOrEqual(1);
  });

  it("does not set reasoning when no override is given", () => {
    // no client request, no suffix, config default is null → reasoning field absent
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.reasoning).toBeUndefined();
  });

  it("does not set service_tier when suffix has none and config default is null", () => {
    const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
    expect(result.service_tier).toBeUndefined();
  });

  // ── Response format (Structured Outputs) ──────────────────────────

  describe("response_format via responseMimeType", () => {
    it("converts application/json without responseSchema to json_object", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
        "gpt-5.4",
      );
      expect(result.text).toEqual({ format: { type: "json_object" } });
    });

    it("converts application/json with responseSchema to json_schema", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        }),
        "gpt-5.4",
      );
      expect(result.text?.format).toMatchObject({
        type: "json_schema",
        name: "gemini_schema",
        strict: true,
      });
      // Should auto-inject additionalProperties: false
      expect(result.text?.format.schema).toHaveProperty("additionalProperties", false);
    });

    it("does not set text.format when responseMimeType is not application/json", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          generationConfig: {
            responseMimeType: "text/plain",
          },
        }),
        "gpt-5.4",
      );
      expect(result.text).toBeUndefined();
    });

    it("does not set text.format when no generationConfig", () => {
      const result = translateGeminiToCodexRequest(makeRequest(), "gpt-5.4");
      expect(result.text).toBeUndefined();
    });
  });

  // ── Multiple function calls ───────────────────────────────────────

  describe("multiple function calls", () => {
    it("generates incremental call_ids for multiple functionCalls", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          contents: [
            {
              role: "model",
              parts: [
                { functionCall: { name: "search", args: { q: "a" } } },
                { functionCall: { name: "fetch", args: { url: "b" } } },
              ],
            },
          ],
        }),
        "gpt-5.4",
      );
      const fcItems = result.input.filter(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItems).toHaveLength(2);
      expect(fcItems[0]).toMatchObject({ call_id: "fc_0", name: "search" });
      expect(fcItems[1]).toMatchObject({ call_id: "fc_1", name: "fetch" });
    });
  });

  // ── systemInstruction edge cases ──────────────────────────────────

  describe("systemInstruction edge cases", () => {
    it("joins multiple systemInstruction parts", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          systemInstruction: {
            parts: [
              { text: "First part." },
              { text: "Second part." },
            ],
          },
        }),
        "gpt-5.4",
      );
      expect(result.instructions).toContain("First part.");
      expect(result.instructions).toContain("Second part.");
    });
  });

  // ── thought parts edge cases ──────────────────────────────────────

  describe("thought parts edge cases", () => {
    it("returns empty string for model turn with only thought parts", () => {
      const result = translateGeminiToCodexRequest(
        makeRequest({
          contents: [
            {
              role: "model",
              parts: [
                { text: "thinking...", thought: true },
              ],
            },
          ],
        }),
        "gpt-5.4",
      );
      const assistant = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistant).toBeDefined();
      expect((assistant as { content: string }).content).toBe("");
    });
  });
});

describe("geminiContentsToMessages", () => {
  it("converts basic contents to role/content pairs", () => {
    const contents = [
      { role: "user" as const, parts: [{ text: "Hello" }] },
      { role: "model" as const, parts: [{ text: "Hi there" }] },
    ];
    const messages = geminiContentsToMessages(contents);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("maps 'model' role to 'assistant'", () => {
    const contents = [{ role: "model" as const, parts: [{ text: "Response" }] }];
    const messages = geminiContentsToMessages(contents);
    expect(messages[0].role).toBe("assistant");
  });

  it("prepends systemInstruction as system message", () => {
    const contents = [{ role: "user" as const, parts: [{ text: "Hi" }] }];
    const systemInstruction = { parts: [{ text: "You are a coding assistant." }] };
    const messages = geminiContentsToMessages(contents, systemInstruction);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a coding assistant.",
    });
    expect(messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("does not add system message when no systemInstruction provided", () => {
    const contents = [{ role: "user" as const, parts: [{ text: "Hi" }] }];
    const messages = geminiContentsToMessages(contents);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("extracts text from multiple parts joined by newline", () => {
    const contents = [
      {
        role: "user" as const,
        parts: [{ text: "Line 1" }, { text: "Line 2" }],
      },
    ];
    const messages = geminiContentsToMessages(contents);
    expect(messages[0].content).toBe("Line 1\nLine 2");
  });
});
