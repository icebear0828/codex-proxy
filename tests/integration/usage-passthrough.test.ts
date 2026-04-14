/**
 * Integration tests for token usage passthrough across all three output formats.
 * Verifies that cached_tokens and reasoning_tokens are correctly propagated
 * from Codex events through OpenAI, Anthropic, and Gemini translations.
 */

import { vi, describe, it, expect } from "vitest";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";

// ── Mock iterateCodexEvents to yield controlled events ──────────────

let mockEvents: ExtractedEvent[] = [];

vi.mock("@src/translation/codex-event-extractor.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    iterateCodexEvents: vi.fn(async function* () {
      for (const evt of mockEvents) {
        yield evt;
      }
    }),
  };
});

import { collectCodexResponse, streamCodexToOpenAI } from "@src/translation/codex-to-openai.js";
import { collectCodexToAnthropicResponse } from "@src/translation/codex-to-anthropic.js";
import { collectCodexToGeminiResponse } from "@src/translation/codex-to-gemini.js";
import type { CodexApi } from "@src/proxy/codex-api.js";
import type { ChatCompletionChunk } from "@src/types/openai.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

// ── Event factories with extended usage ─────────────────────────────

function createUsageEvents(opts: {
  cached_tokens?: number;
  reasoning_tokens?: number;
}): ExtractedEvent[] {
  return [
    {
      typed: { type: "response.created", response: { id: "resp_u1" } },
      responseId: "resp_u1",
    },
    {
      typed: { type: "response.in_progress", response: { id: "resp_u1" } },
      responseId: "resp_u1",
    },
    {
      typed: { type: "response.output_text.delta", delta: "Hello" },
      textDelta: "Hello",
    },
    {
      typed: {
        type: "response.completed",
        response: {
          id: "resp_u1",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            ...(opts.cached_tokens != null ? { cached_tokens: opts.cached_tokens } : {}),
            ...(opts.reasoning_tokens != null ? { reasoning_tokens: opts.reasoning_tokens } : {}),
          },
        },
      },
      responseId: "resp_u1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        ...(opts.cached_tokens != null ? { cached_tokens: opts.cached_tokens } : {}),
        ...(opts.reasoning_tokens != null ? { reasoning_tokens: opts.reasoning_tokens } : {}),
      },
    },
  ];
}

describe("usage passthrough", () => {
  describe("OpenAI format", () => {
    it("cached_tokens in prompt_tokens_details", async () => {
      mockEvents = createUsageEvents({ cached_tokens: 30 });
      const { response } = await collectCodexResponse(fakeCodexApi, fakeResponse, "gpt-5.2-codex");

      expect(response.usage.prompt_tokens).toBe(100);
      expect(response.usage.completion_tokens).toBe(50);
      expect(response.usage.total_tokens).toBe(150);
      expect(response.usage.prompt_tokens_details).toBeDefined();
      expect(response.usage.prompt_tokens_details!.cached_tokens).toBe(30);
    });

    it("reasoning_tokens in completion_tokens_details", async () => {
      mockEvents = createUsageEvents({ reasoning_tokens: 20 });
      const { response } = await collectCodexResponse(fakeCodexApi, fakeResponse, "gpt-5.2-codex");

      expect(response.usage.completion_tokens_details).toBeDefined();
      expect(response.usage.completion_tokens_details!.reasoning_tokens).toBe(20);
    });

    it("both cached and reasoning tokens together", async () => {
      mockEvents = createUsageEvents({ cached_tokens: 30, reasoning_tokens: 20 });
      const { response } = await collectCodexResponse(fakeCodexApi, fakeResponse, "gpt-5.2-codex");

      expect(response.usage.prompt_tokens_details!.cached_tokens).toBe(30);
      expect(response.usage.completion_tokens_details!.reasoning_tokens).toBe(20);
    });
  });

  describe("Anthropic format", () => {
    it("cache_read_input_tokens from cached_tokens", async () => {
      mockEvents = createUsageEvents({ cached_tokens: 30 });
      const { response } = await collectCodexToAnthropicResponse(
        fakeCodexApi, fakeResponse, "gpt-5.2-codex",
      );

      expect(response.usage.input_tokens).toBe(100);
      expect(response.usage.output_tokens).toBe(50);
      expect(response.usage.cache_read_input_tokens).toBe(30);
    });
  });

  describe("Gemini format", () => {
    it("cachedContentTokenCount from cached_tokens", async () => {
      mockEvents = createUsageEvents({ cached_tokens: 30 });
      const { response } = await collectCodexToGeminiResponse(
        fakeCodexApi, fakeResponse, "gpt-5.2-codex",
      );

      expect(response.usageMetadata).toBeDefined();
      expect(response.usageMetadata!.promptTokenCount).toBe(100);
      expect(response.usageMetadata!.candidatesTokenCount).toBe(50);
      expect(response.usageMetadata!.totalTokenCount).toBe(150);
      expect(response.usageMetadata!.cachedContentTokenCount).toBe(30);
    });
  });

  describe("OpenAI streaming", () => {
    it("usage in final chunk includes token details", async () => {
      mockEvents = createUsageEvents({ cached_tokens: 30, reasoning_tokens: 20 });
      const chunks: string[] = [];

      for await (const chunk of streamCodexToOpenAI(fakeCodexApi, fakeResponse, "gpt-5.2-codex")) {
        chunks.push(chunk);
      }

      // Find the chunk with finish_reason (the final data chunk before [DONE])
      const dataChunks = chunks
        .filter((c) => c.startsWith("data: {"))
        .map((c) => JSON.parse(c.replace("data: ", "")) as ChatCompletionChunk);

      const finalChunk = dataChunks.find(
        (c) => c.choices[0]?.finish_reason === "stop",
      );
      expect(finalChunk).toBeDefined();
      expect(finalChunk!.usage).toBeDefined();
      expect(finalChunk!.usage!.prompt_tokens).toBe(100);
      expect(finalChunk!.usage!.completion_tokens).toBe(50);
      expect(finalChunk!.usage!.prompt_tokens_details?.cached_tokens).toBe(30);
      expect(finalChunk!.usage!.completion_tokens_details?.reasoning_tokens).toBe(20);
    });
  });

  describe("streaming vs non-streaming consistency", () => {
    it("both modes produce the same token totals", async () => {
      const events = createUsageEvents({ cached_tokens: 30, reasoning_tokens: 20 });

      // Non-streaming
      mockEvents = [...events];
      const { response: collectResult } = await collectCodexResponse(
        fakeCodexApi, fakeResponse, "gpt-5.2-codex",
      );

      // Streaming
      mockEvents = [...events];
      const chunks: string[] = [];
      for await (const chunk of streamCodexToOpenAI(fakeCodexApi, fakeResponse, "gpt-5.2-codex")) {
        chunks.push(chunk);
      }

      const dataChunks = chunks
        .filter((c) => c.startsWith("data: {"))
        .map((c) => JSON.parse(c.replace("data: ", "")) as ChatCompletionChunk);

      const finalChunk = dataChunks.find(
        (c) => c.choices[0]?.finish_reason === "stop",
      );

      // Verify totals match
      expect(finalChunk!.usage!.prompt_tokens).toBe(collectResult.usage.prompt_tokens);
      expect(finalChunk!.usage!.completion_tokens).toBe(collectResult.usage.completion_tokens);
      expect(finalChunk!.usage!.total_tokens).toBe(collectResult.usage.total_tokens);
      expect(finalChunk!.usage!.prompt_tokens_details?.cached_tokens).toBe(
        collectResult.usage.prompt_tokens_details?.cached_tokens,
      );
      expect(finalChunk!.usage!.completion_tokens_details?.reasoning_tokens).toBe(
        collectResult.usage.completion_tokens_details?.reasoning_tokens,
      );
    });
  });
});
