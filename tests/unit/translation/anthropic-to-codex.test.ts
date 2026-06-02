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
  it("does not forward max_tokens to Codex", () => {
    const result = translateAnthropicToCodexRequest(
      makeRequest({ max_tokens: 8192 }),
    );
    expect(result).not.toHaveProperty("max_output_tokens");
  });

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

    // Real Claude Code 2.1.84 emits the billing header as a standalone block[0]
    // with per-request rotating cc_version + cch. Tests must prove the strip is
    // invariant across that rotation, otherwise the cache-buster leaks into
    // `instructions` and tanks upstream prompt cache.
    it.each([
      "x-anthropic-billing-header: cc_version=2.1.84.c8e; cc_entrypoint=cli; cch=da09b;",
      "x-anthropic-billing-header: cc_version=2.1.84.76b; cc_entrypoint=cli; cch=46d1d;",
      "x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=3c1ed;",
      "x-anthropic-billing-header: cc_version=2.1.84.5b4; cc_entrypoint=cli; cch=8f29c;",
      "x-anthropic-billing-header: cc_version=2.1.84.4f3; cc_entrypoint=cli; cch=d1658;",
    ])("strips Claude Code billing header variant: %s", (billingText) => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: billingText },
            {
              type: "text" as const,
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text" as const,
              text: "\nYou are an interactive agent that helps users with software engineering tasks.",
              cache_control: { type: "ephemeral" },
            },
          ],
        }),
      );
      expect(result.instructions).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive agent that helps users with software engineering tasks.",
      );
      expect(result.instructions).not.toMatch(/cch=|cc_version=|x-anthropic-billing/);
    });

    it("produces identical instructions across rotating cc_version + cch values", () => {
      const baseSystem = (billingText: string) => [
        { type: "text" as const, text: billingText },
        {
          type: "text" as const,
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" as const },
        },
      ];
      const a = translateAnthropicToCodexRequest(
        makeRequest({
          system: baseSystem(
            "x-anthropic-billing-header: cc_version=2.1.84.c8e; cc_entrypoint=cli; cch=da09b;",
          ),
        }),
      );
      const b = translateAnthropicToCodexRequest(
        makeRequest({
          system: baseSystem(
            "x-anthropic-billing-header: cc_version=2.1.84.4f3; cc_entrypoint=cli; cch=d1658;",
          ),
        }),
      );
      expect(a.instructions).toBe(b.instructions);
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

    it("preserves system and developer message roles in order", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            { role: "system", content: "You are an expert engineer." },
            { role: "developer", content: "Follow company coding standards." },
            { role: "user", content: "hello" },
          ],
        } as Partial<AnthropicMessagesRequest>),
      );
      expect(result.instructions).toBe("You are a helpful assistant.");
      expect(result.input).toEqual([
        { role: "system", content: "You are an expert engineer." },
        { role: "developer", content: "Follow company coding standards." },
        { role: "user", content: "hello" },
      ]);
    });

    it("keeps tool call items ordered around system and developer messages", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            { role: "system", content: "You are an expert engineer." },
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
            { role: "developer", content: "Keep coding standards." },
            { role: "user", content: "continue" },
          ],
        } as Partial<AnthropicMessagesRequest>),
      );
      expect(result.input).toEqual([
        { role: "system", content: "You are an expert engineer." },
        {
          type: "function_call",
          call_id: "toolu_01",
          name: "search",
          arguments: '{"query":"test"}',
        },
        {
          type: "function_call_output",
          call_id: "toolu_01",
          output: "result data",
        },
        { role: "developer", content: "Keep coding standards." },
        { role: "user", content: "continue" },
      ]);
    });

    it("downgrades unknown message roles to user", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            messages: [{ role: "future_role", content: "new role content" }],
          } as Partial<AnthropicMessagesRequest>),
        );
        expect(result.input).toEqual([{ role: "user", content: "new role content" }]);
        expect(warn).toHaveBeenCalledWith(
          "[anthropic-to-codex] Unknown message role, downgrading to user:",
          "future_role",
        );
      } finally {
        warn.mockRestore();
      }
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

});
