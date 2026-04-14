/**
 * Tests for Codex → OpenAI Chat Completions translation.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import {
  simpleTextStream,
  toolCallStream,
  reasoningStream,
  errorStream,
  emptyStream,
  multiToolCallStream,
  usageStream,
  toolCallNoDeltaStream,
} from "@fixtures/sse-streams.js";
import {
  createCreated,
  createInProgress,
  createTextDelta,
  createCompleted,
  createFunctionCallDelta,
} from "@helpers/events.js";

// Mock iterateCodexEvents to yield our fixture events
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

import { streamCodexToOpenAI, collectCodexResponse } from "@src/translation/codex-to-openai.js";
import type { CodexApi } from "@src/proxy/codex-api.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

async function collectStreamOutput(events: ExtractedEvent[], wantReasoning = false): Promise<string[]> {
  mockEvents = events;
  const chunks: string[] = [];
  for await (const chunk of streamCodexToOpenAI(fakeCodexApi, fakeResponse, "gpt-5.4", undefined, undefined, wantReasoning)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("streamCodexToOpenAI", () => {
  it("streams text deltas as chat.completion.chunk", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));

    // Should have: role chunk + "Hello" + ", world!" + completed + DONE
    expect(dataChunks.length).toBeGreaterThanOrEqual(3);

    // Check first non-role chunk contains "Hello"
    const textChunks = dataChunks.filter((c) => c.includes('"content"'));
    expect(textChunks.length).toBeGreaterThan(0);
  });

  it("emits [DONE] at the end", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    expect(chunks[chunks.length - 1]).toBe("data: [DONE]\n\n");
  });

  it("sets finish_reason to tool_calls when tool calls present", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const lastDataChunk = chunks.filter((c) => c.startsWith("data: {")).pop()!;
    const parsed = JSON.parse(lastDataChunk.replace("data: ", ""));
    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
  });

  it("emits reasoning_content when wantReasoning is true", async () => {
    const chunks = await collectStreamOutput(reasoningStream(), true);
    const reasoningChunks = chunks.filter((c) => c.includes("reasoning_content"));
    expect(reasoningChunks.length).toBeGreaterThan(0);
  });

  it("handles error events", async () => {
    const chunks = await collectStreamOutput(errorStream());
    const errorChunks = chunks.filter((c) => c.includes("[Error]"));
    expect(errorChunks.length).toBeGreaterThan(0);
  });

  it("injects error text for empty response", async () => {
    const chunks = await collectStreamOutput(emptyStream());
    const errorChunks = chunks.filter((c) => c.includes("empty response"));
    expect(errorChunks.length).toBeGreaterThan(0);
  });
});

describe("collectCodexResponse", () => {
  it("collects text into a non-streaming response", async () => {
    mockEvents = simpleTextStream();
    const { response, usage, responseId } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.object).toBe("chat.completion");
    expect(response.choices[0].message.content).toBe("Hello, world!");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    expect(responseId).toBe("resp_1");
  });

  it("collects tool calls", async () => {
    mockEvents = toolCallStream();
    const { response } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    expect(response.choices[0].message.tool_calls![0].function.name).toBe("get_weather");
  });

  it("includes reasoning_content when requested", async () => {
    mockEvents = reasoningStream();
    const { response } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4", true,
    );
    expect(response.choices[0].message.reasoning_content).toContain("think");
  });

  it("throws on error event", async () => {
    mockEvents = errorStream();
    await expect(collectCodexResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("Codex API error");
  });

  it("throws EmptyResponseError for empty stream", async () => {
    mockEvents = emptyStream();
    await expect(collectCodexResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("empty response");
  });
});

// ── Usage details (streaming) ─────────────────────────────────────────

describe("streamCodexToOpenAI — usage details", () => {
  it("includes cached_tokens and reasoning_tokens in final streaming chunk", async () => {
    const chunks = await collectStreamOutput(usageStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));
    const lastData = dataChunks[dataChunks.length - 1];
    const parsed = JSON.parse(lastData.replace("data: ", ""));
    expect(parsed.usage).toBeDefined();
    expect(parsed.usage.prompt_tokens_details?.cached_tokens).toBe(30);
    expect(parsed.usage.completion_tokens_details?.reasoning_tokens).toBe(10);
  });

  it("includes prompt_tokens and completion_tokens in final chunk", async () => {
    const chunks = await collectStreamOutput(usageStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));
    const lastData = dataChunks[dataChunks.length - 1];
    const parsed = JSON.parse(lastData.replace("data: ", ""));
    expect(parsed.usage.prompt_tokens).toBe(50);
    expect(parsed.usage.completion_tokens).toBe(20);
    expect(parsed.usage.total_tokens).toBe(70);
  });
});

// ── Function call without deltas ──────────────────────────────────────

describe("streamCodexToOpenAI — function call without deltas", () => {
  it("emits full arguments in a single tool_call chunk when no deltas streamed", async () => {
    const chunks = await collectStreamOutput(toolCallNoDeltaStream());
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));
    const toolChunks = dataChunks.filter((c) => c.includes('"tool_calls"'));
    // Should have: start chunk + done chunk (full arguments)
    expect(toolChunks.length).toBeGreaterThanOrEqual(2);
    // The done chunk should contain the full arguments (escaped in JSON)
    const doneChunk = toolChunks.find((c) => c.includes('\\"key\\"'));
    expect(doneChunk).toBeDefined();
  });
});

// ── Usage details (non-streaming) ─────────────────────────────────────

describe("collectCodexResponse — usage details", () => {
  it("includes cached_tokens in non-streaming response usage", async () => {
    mockEvents = usageStream();
    const { response } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usage.prompt_tokens).toBe(50);
    expect(response.usage.completion_tokens).toBe(20);
    expect(response.usage.prompt_tokens_details?.cached_tokens).toBe(30);
    expect(response.usage.completion_tokens_details?.reasoning_tokens).toBe(10);
  });

  it("omits token details when not present", async () => {
    mockEvents = simpleTextStream();
    const { response } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usage.prompt_tokens_details).toBeUndefined();
    expect(response.usage.completion_tokens_details).toBeUndefined();
  });

  it("collects multiple tool calls", async () => {
    mockEvents = multiToolCallStream();
    const { response } = await collectCodexResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.choices[0].message.tool_calls).toHaveLength(2);
    expect(response.choices[0].message.tool_calls![0].function.name).toBe("search");
    expect(response.choices[0].message.tool_calls![1].function.name).toBe("fetch");
  });
});

// ── Unregistered callId defaults to index 0 ──────────────────────────

describe("streamCodexToOpenAI — unregistered callId", () => {
  it("defaults tool_call index to 0 for delta with unknown callId", async () => {
    // Create a stream where a functionCallDelta arrives with no prior functionCallStart
    const events: ExtractedEvent[] = [
      createCreated("resp_unreg"),
      createInProgress("resp_unreg"),
      // No functionCallStart — delta arrives for an unregistered callId
      createFunctionCallDelta("unknown_call", '{"key":"val"}'),
      createCompleted("resp_unreg", { input_tokens: 10, output_tokens: 5 }),
    ];
    const chunks = await collectStreamOutput(events);
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));
    const toolChunks = dataChunks.filter((c) => c.includes('"tool_calls"'));
    expect(toolChunks.length).toBeGreaterThan(0);
    // Parse the tool_call chunk — index should default to 0
    const parsed = JSON.parse(toolChunks[0].replace("data: ", ""));
    expect(parsed.choices[0].delta.tool_calls[0].index).toBe(0);
  });
});

// ── Usage without reasoning_tokens omits completion_tokens_details ────

describe("streamCodexToOpenAI — usage without reasoning_tokens", () => {
  it("omits completion_tokens_details when reasoning_tokens absent", async () => {
    // Usage with cached_tokens but no reasoning_tokens
    const events: ExtractedEvent[] = [
      createCreated("resp_usage"),
      createInProgress("resp_usage"),
      createTextDelta("Result"),
      createCompleted("resp_usage", { input_tokens: 50, output_tokens: 20, cached_tokens: 30 }),
    ];
    const chunks = await collectStreamOutput(events);
    const dataChunks = chunks.filter((c) => c.startsWith("data: {"));
    const lastData = dataChunks[dataChunks.length - 1];
    const parsed = JSON.parse(lastData.replace("data: ", ""));
    expect(parsed.usage).toBeDefined();
    expect(parsed.usage.prompt_tokens_details?.cached_tokens).toBe(30);
    expect(parsed.usage.completion_tokens_details).toBeUndefined();
  });
});

// ── wantReasoning=false suppresses reasoning_content ──────────────────

describe("streamCodexToOpenAI — reasoning suppression", () => {
  it("does not emit reasoning_content when wantReasoning is false", async () => {
    const chunks = await collectStreamOutput(reasoningStream(), false);
    const reasoningChunks = chunks.filter((c) => c.includes("reasoning_content"));
    expect(reasoningChunks).toHaveLength(0);
  });
});

// ── onResponseId callback ─────────────────────────────────────────────

describe("streamCodexToOpenAI — onResponseId callback", () => {
  it("calls onResponseId with the response ID", async () => {
    mockEvents = simpleTextStream();
    let receivedId: string | undefined;
    const chunks: string[] = [];
    for await (const chunk of streamCodexToOpenAI(
      fakeCodexApi, fakeResponse, "gpt-5.4",
      undefined,
      (id) => { receivedId = id; },
    )) {
      chunks.push(chunk);
    }
    expect(receivedId).toBe("resp_1");
  });
});
