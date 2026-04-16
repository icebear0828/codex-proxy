/**
 * Tests for translateAnthropicToCodexRequest — Anthropic Messages → Codex format.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/translation/shared-utils.js", () => ({
  buildInstructions: vi.fn((text: string) => text),
  budgetToEffort: vi.fn((budget: number | undefined) => {
    if (!budget || budget <= 0) return undefined;
    if (budget < 2000) return "low";
    if (budget < 8000) return "medium";
    if (budget < 20000) return "high";
    return "xhigh";
  }),
}));

vi.mock("@src/translation/tool-format.js", () => ({
  anthropicToolsToCodex: vi.fn((tools: unknown[]) => tools),
  anthropicToolChoiceToCodex: vi.fn(() => undefined),
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

import { translateAnthropicToCodexRequest } from "@src/translation/anthropic-to-codex.js";
import { anthropicToolsToCodex, anthropicToolChoiceToCodex } from "@src/translation/tool-format.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

function makeRequest(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: "gpt-5.4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  } as AnthropicMessagesRequest;
}

describe("translateAnthropicToCodexRequest", () => {
  // ── System instructions ──────────────────────────────────────────────

  describe("system instructions", () => {
    it("uses string system as instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "Be concise." }),
      );
      expect(result.instructions).toBe("Be concise.");
    });

    it("joins text block array system into instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "First paragraph." },
            { type: "text" as const, text: "Second paragraph." },
          ],
        }),
      );
      expect(result.instructions).toBe("First paragraph.\n\nSecond paragraph.");
    });

    it("strips Claude billing header noise from system blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            {
              type: "text" as const,
              text: "x-anthropic-billing-header: cc_version=2.1.100.db0; cch=abcd1;",
            },
            { type: "text" as const, text: "Keep answers short." },
          ],
        }),
      );
      expect(result.instructions).toBe("Keep answers short.");
    });

    it("falls back to default instructions when no system provided", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.instructions).toBe("You are a helpful assistant.");
    });
  });

  // ── Messages ─────────────────────────────────────────────────────────

  describe("messages", () => {
    it("converts user text string to input item", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("converts user with array content (text blocks) to text string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Line one" },
                { type: "text" as const, text: "Line two" },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Line one\nLine two" });
    });

    it("converts image block to input_image content part", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Describe this" },
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png",
                    data: "iVBOR...",
                  },
                },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      const item = result.input[0];
      expect(Array.isArray(item.content)).toBe(true);
      const parts = item.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "input_text", text: "Describe this" });
      expect(parts[1]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,iVBOR...",
      });
    });

    it("converts tool_use block to function_call input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_01",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItem).toBeDefined();
      expect(fcItem).toMatchObject({
        type: "function_call",
        call_id: "toolu_01",
        name: "search",
        arguments: '{"query":"test"}',
      });
    });

    it("converts tool_result block to function_call_output input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_01",
                  content: "result data",
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect(outputItem).toMatchObject({
        type: "function_call_output",
        call_id: "toolu_01",
        output: "result data",
      });
    });

    it("prepends 'Error: ' to tool_result output when is_error is true", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_02",
                  content: "something went wrong",
                  is_error: true,
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe(
        "Error: something went wrong",
      );
    });
  });

  // ── Thinking → reasoning effort ──────────────────────────────────────

  describe("thinking to reasoning effort", () => {
    it("maps enabled thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      // budgetToEffort(5000) → "medium"
      expect(result.reasoning?.effort).toBe("medium");
    });

    it("maps enabled thinking with small budget to low effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 500 },
        }),
      );
      expect(result.reasoning?.effort).toBe("low");
    });

    it("maps disabled thinking to undefined effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "disabled" },
        }),
      );
      // disabled → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });

    it("maps adaptive thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive", budget_tokens: 15000 },
        }),
      );
      // budgetToEffort(15000) → "high"
      expect(result.reasoning?.effort).toBe("high");
    });

    it("maps adaptive thinking without budget_tokens to undefined", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive" },
        }),
      );
      // adaptive without budget → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });
  });

  // ── Model parsing ────────────────────────────────────────────────────

  describe("model parsing", () => {
    it("resolves 'codex' alias via parseModelName", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "codex" }),
      );
      expect(result.model).toBe("gpt-5.4");
    });

    it("extracts service_tier from -fast suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-fast" }),
      );
      expect(result.service_tier).toBe("fast");
    });

    it("extracts reasoning effort from -high suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-high" }),
      );
      expect(result.reasoning?.effort).toBe("high");
    });
  });

  // ── Tools ────────────────────────────────────────────────────────────

  describe("tools", () => {
    it("delegates tools array to anthropicToolsToCodex", () => {
      const tools = [
        { name: "search", description: "Search the web", input_schema: {} },
      ];
      translateAnthropicToCodexRequest(makeRequest({ tools }));

      expect(anthropicToolsToCodex).toHaveBeenCalledWith(tools);
    });

    it("delegates tool_choice to anthropicToolChoiceToCodex", () => {
      const toolChoice = { type: "auto" as const };
      translateAnthropicToCodexRequest(makeRequest({ tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, undefined);
    });

    it("passes tools context when converting tool_choice", () => {
      const tools = [
        { name: "web_search", description: "Custom search", input_schema: {} },
      ];
      const toolChoice = { type: "tool" as const, name: "web_search" };
      translateAnthropicToCodexRequest(makeRequest({ tools, tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, tools);
    });

    it("does not inject hosted web_search by default", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());

      expect(result.tools).toEqual([]);
    });

    it("injects hosted web_search when explicitly requested", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest(),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search" }]);
    });

    it("does not duplicate hosted web_search when injected and already present", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ tools: [{ type: "web_search" as const, name: "web_search" }] }),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search", name: "web_search" }]);
    });
  });

  // ── Fixed fields ─────────────────────────────────────────────────────

  describe("fixed fields", () => {
    it("always sets stream to true", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.stream).toBe(true);
    });

    it("always sets store to false", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.store).toBe(false);
    });

    it("does not set reasoning when no effort is configured or requested", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.reasoning).toBeUndefined();
    });
  });

  // ── Empty messages ───────────────────────────────────────────────────

  describe("empty messages", () => {
    it("ensures at least one input item when messages produce no items", () => {
      // All thinking blocks get filtered out, producing no items
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
              ],
            },
          ],
        }),
      );
      expect(result.input.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── tool_result with array content ─────────────────────────────────

  describe("tool_result with array content", () => {
    it("converts tool_result with array text content to joined string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_arr",
                  content: [
                    { type: "text" as const, text: "Line 1" },
                    { type: "text" as const, text: "Line 2" },
                  ],
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("Line 1\nLine 2");
    });
  });

  // ── tool_result with image content (screenshot scenario) ───────────

  describe("tool_result with image content", () => {
    it("extracts images from tool_result into a following user message", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img",
                  content: [
                    { type: "text" as const, text: "Screenshot captured" },
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/png",
                        data: "iVBORw0KGgo=",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      // Should produce function_call_output with text only
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("Screenshot captured");

      // Should produce a follow-up user message with the image
      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("input_image");
      expect(parts[0].image_url).toBe("data:image/png;base64,iVBORw0KGgo=");
    });

    it("handles tool_result with image-only content (no text)", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img2",
                  content: [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/jpeg",
                        data: "/9j/4AAQ",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("");

      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts[0].image_url).toBe("data:image/jpeg;base64,/9j/4AAQ");
    });

    it("handles tool_result with multiple images", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_multi",
                  content: [
                    { type: "text" as const, text: "Two screenshots" },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img1" },
                    },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img2" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toHaveLength(2);
      expect(parts[0].image_url).toBe("data:image/png;base64,img1");
      expect(parts[1].image_url).toBe("data:image/png;base64,img2");
    });
  });

  // ── Mixed assistant content ────────────────────────────────────────

  describe("mixed assistant content", () => {
    it("converts assistant text block to assistant input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Here is the result" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("Here is the result");
    });

    it("handles assistant with both text and tool_use blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Let me search" },
                {
                  type: "tool_use" as const,
                  id: "toolu_mixed",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(assistantItem).toBeDefined();
      expect(fcItem).toBeDefined();
    });

    it("converts multiple tool_use blocks in single assistant message", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_1",
                  name: "search",
                  input: { query: "a" },
                },
                {
                  type: "tool_use" as const,
                  id: "toolu_2",
                  name: "fetch",
                  input: { url: "https://example.com" },
                },
              ],
            },
          ],
        }),
      );
      const fcItems = result.input.filter(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItems).toHaveLength(2);
    });
  });

  // ── Thinking block filtering ──────────────────────────────────────

  describe("thinking block handling", () => {
    it("filters out thinking blocks from assistant text content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
                { type: "text" as const, text: "visible answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("visible answer");
    });

    it("filters out redacted_thinking blocks from assistant content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "redacted_thinking" as const, data: "encrypted" },
                { type: "text" as const, text: "answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("answer");
    });
  });

  // ── System instruction edge cases ─────────────────────────────────

  describe("system instruction edge cases", () => {
    it("uses default instructions for empty system string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "" }),
      );
      expect(result.instructions).toBe("You are a helpful assistant.");
    });

    it("handles single text block system", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [{ type: "text" as const, text: "Only one block." }],
        }),
      );
      expect(result.instructions).toBe("Only one block.");
    });
  });
});
