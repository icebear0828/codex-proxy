/**
 * Tests for Codex → Gemini format translation.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import {
  simpleTextStream,
  toolCallStream,
  errorStream,
  emptyStream,
  multiToolCallStream,
  usageStream,
} from "@fixtures/sse-streams.js";

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

import { streamCodexToGemini, collectCodexToGeminiResponse } from "@src/translation/codex-to-gemini.js";
import type { CodexApi } from "@src/proxy/codex-api.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

async function collectStreamOutput(events: ExtractedEvent[]): Promise<string[]> {
  mockEvents = events;
  const chunks: string[] = [];
  for await (const chunk of streamCodexToGemini(fakeCodexApi, fakeResponse, "gpt-5.4")) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("streamCodexToGemini", () => {
  it("streams text deltas as Gemini candidates", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    expect(dataChunks.length).toBeGreaterThan(0);

    const first = JSON.parse(dataChunks[0].slice(6));
    expect(first.candidates[0].content.role).toBe("model");
  });

  it("emits final chunk with STOP finishReason and usage", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    const last = JSON.parse(dataChunks[dataChunks.length - 1].slice(6));
    expect(last.candidates[0].finishReason).toBe("STOP");
    expect(last.usageMetadata).toBeDefined();
    expect(last.usageMetadata.promptTokenCount).toBe(10);
    expect(last.usageMetadata.candidatesTokenCount).toBe(5);
  });

  it("emits functionCall parts for tool calls", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    const fcChunk = dataChunks.find((c) => c.includes("functionCall"));
    expect(fcChunk).toBeDefined();
    const parsed = JSON.parse(fcChunk!.slice(6));
    expect(parsed.candidates[0].content.parts[0].functionCall.name).toBe("get_weather");
  });

  it("handles error events", async () => {
    const chunks = await collectStreamOutput(errorStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    expect(dataChunks.length).toBeGreaterThan(0);
    const parsed = JSON.parse(dataChunks[0].slice(6));
    expect(parsed.candidates[0].finishReason).toBe("OTHER");
  });

  it("injects error text for empty response", async () => {
    const chunks = await collectStreamOutput(emptyStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    const errorChunk = dataChunks.find((c) => c.includes("empty response"));
    expect(errorChunk).toBeDefined();
  });
});

describe("collectCodexToGeminiResponse", () => {
  it("collects text into Gemini response", async () => {
    mockEvents = simpleTextStream();
    const { response, usage } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.candidates[0].content.parts[0].text).toBe("Hello, world!");
    expect(response.candidates[0].finishReason).toBe("STOP");
    expect(usage.input_tokens).toBe(10);
    expect(response.usageMetadata?.promptTokenCount).toBe(10);
  });

  it("collects function calls", async () => {
    mockEvents = toolCallStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    const fcPart = response.candidates[0].content.parts.find((p) => p.functionCall);
    expect(fcPart).toBeDefined();
    expect(fcPart!.functionCall!.name).toBe("get_weather");
  });

  it("throws on error", async () => {
    mockEvents = errorStream();
    await expect(collectCodexToGeminiResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("Codex API error");
  });

  it("throws EmptyResponseError for empty stream", async () => {
    mockEvents = emptyStream();
    await expect(collectCodexToGeminiResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("empty response");
  });
});

// ── Streaming additional details ──────────────────────────────────────

describe("streamCodexToGemini — additional details", () => {
  it("includes modelVersion in each streaming chunk", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    for (const dc of dataChunks) {
      const parsed = JSON.parse(dc.slice(6));
      expect(parsed.modelVersion).toBe("gpt-5.4");
    }
  });

  it("includes cachedContentTokenCount in final chunk when cached_tokens present", async () => {
    mockEvents = usageStream();
    const chunks: string[] = [];
    for await (const chunk of streamCodexToGemini(fakeCodexApi, fakeResponse, "gpt-5.4")) {
      chunks.push(chunk);
    }
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    const lastData = JSON.parse(dataChunks[dataChunks.length - 1].slice(6));
    expect(lastData.usageMetadata?.cachedContentTokenCount).toBe(30);
  });

  it("emits correct finishReason OTHER with error text for error events", async () => {
    const chunks = await collectStreamOutput(errorStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: "));
    const parsed = JSON.parse(dataChunks[0].slice(6));
    expect(parsed.candidates[0].finishReason).toBe("OTHER");
    expect(parsed.candidates[0].content.parts[0].text).toContain("[Error]");
  });
});

// ── Collect response additional details ───────────────────────────────

describe("collectCodexToGeminiResponse — additional details", () => {
  it("includes cachedContentTokenCount in usageMetadata when present", async () => {
    mockEvents = usageStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usageMetadata?.cachedContentTokenCount).toBe(30);
  });

  it("omits cachedContentTokenCount when not present", async () => {
    mockEvents = simpleTextStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usageMetadata?.cachedContentTokenCount).toBeUndefined();
  });

  it("collects multiple function call parts", async () => {
    mockEvents = multiToolCallStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    const fcParts = response.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].functionCall!.name).toBe("search");
    expect(fcParts[1].functionCall!.name).toBe("fetch");
  });

  it("includes modelVersion in collected response", async () => {
    mockEvents = simpleTextStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.modelVersion).toBe("gpt-5.4");
  });

  it("includes usageMetadata with correct token counts", async () => {
    mockEvents = simpleTextStream();
    const { response } = await collectCodexToGeminiResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usageMetadata?.promptTokenCount).toBe(10);
    expect(response.usageMetadata?.candidatesTokenCount).toBe(5);
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
  });
});
