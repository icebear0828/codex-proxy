import { describe, expect, it, vi } from "vitest";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import {
  createCompleted,
  createCreated,
  createFunctionCallDelta,
  createFunctionCallDone,
  createFunctionCallStart,
  createInProgress,
} from "@helpers/events.js";

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

import { collectCodexToAnthropicResponse, streamCodexToAnthropic } from "@src/translation/codex-to-anthropic.js";
import type { CodexApi } from "@src/proxy/codex-api.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

function readToolStream(args: string, deltas: string[] = []): ExtractedEvent[] {
  return [
    createCreated("resp_read"),
    createInProgress("resp_read"),
    createFunctionCallStart("call_read", "Read"),
    ...deltas.map((delta) => createFunctionCallDelta("call_read", delta)),
    createFunctionCallDone("call_read", "Read", args),
    createCompleted("resp_read", { input_tokens: 10, output_tokens: 5 }),
  ];
}

async function collectStreamInput(events: ExtractedEvent[]): Promise<Record<string, unknown>> {
  mockEvents = events;
  const chunks: string[] = [];
  for await (const chunk of streamCodexToAnthropic(fakeCodexApi, fakeResponse, "gpt-5.5")) {
    chunks.push(chunk);
  }

  const partialJson = chunks
    .map((chunk) => {
      const dataLine = chunk.trim().split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) return "";
      const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      const delta = data.delta;
      if (typeof delta !== "object" || delta === null || Array.isArray(delta)) return "";
      const partial = (delta as Record<string, unknown>).partial_json;
      return typeof partial === "string" ? partial : "";
    })
    .join("");

  return JSON.parse(partialJson) as Record<string, unknown>;
}

describe("Codex to Anthropic Read.pages sanitization", () => {
  it("omits empty Read.pages from streamed tool arguments", async () => {
    const input = await collectStreamInput(readToolStream(
      '{"file_path":"package.json","pages":""}',
    ));

    expect(input).toEqual({ file_path: "package.json" });
  });

  it("omits empty Read.pages when arguments arrive as streaming deltas", async () => {
    const input = await collectStreamInput(readToolStream(
      '{"file_path":"package.json","pages":""}',
      ['{"file_path":"package.json"', ',"pages":""}'],
    ));

    expect(input).toEqual({ file_path: "package.json" });
  });

  it("omits empty Read.pages from collected tool input", async () => {
    mockEvents = readToolStream('{"file_path":"package.json","pages":"   "}');

    const { response } = await collectCodexToAnthropicResponse(fakeCodexApi, fakeResponse, "gpt-5.5");
    const toolBlock = response.content.find((block) => block.type === "tool_use");

    expect(toolBlock?.input).toEqual({ file_path: "package.json" });
  });

  it("keeps non-empty Read.pages ranges", async () => {
    mockEvents = readToolStream('{"file_path":"manual.pdf","pages":"1-2"}');

    const { response } = await collectCodexToAnthropicResponse(fakeCodexApi, fakeResponse, "gpt-5.5");
    const toolBlock = response.content.find((block) => block.type === "tool_use");

    expect(toolBlock?.input).toEqual({ file_path: "manual.pdf", pages: "1-2" });
  });
});
