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

import { streamCodexToAnthropic } from "@src/translation/codex-to-anthropic.js";
import type { CodexApi } from "@src/proxy/codex-api.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

async function collectEvents(events: ExtractedEvent[]): Promise<SSEEvent[]> {
  mockEvents = events;
  const out: SSEEvent[] = [];
  for await (const chunk of streamCodexToAnthropic(fakeCodexApi, fakeResponse, "gpt-5.5")) {
    for (const block of chunk.split("\n\n")) {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      out.push({
        event: eventLine.slice(7),
        data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
      });
    }
  }
  return out;
}

/**
 * Reproduces the event ordering that openai-upstream produces for >=2 tool
 * calls: every `output_item.added` (functionCallStart) is emitted during the
 * stream, but ALL `function_call_arguments.done` (functionCallDone) are
 * deferred to after the stream ends. So the order is:
 *   start(A), start(B), done(A), done(B)
 */
function parallelToolStream(): ExtractedEvent[] {
  return [
    createCreated("resp_par"),
    createInProgress("resp_par"),
    createFunctionCallStart("call_a", "tool_a"),
    createFunctionCallStart("call_b", "tool_b"),
    createFunctionCallDone("call_a", "tool_a", '{"x":1}'),
    createFunctionCallDone("call_b", "tool_b", '{"y":2}'),
    createCompleted("resp_par", { input_tokens: 10, output_tokens: 5 }),
  ];
}

describe("Codex to Anthropic — parallel tool calls", () => {
  it("assigns a distinct content block index to each tool_use block", async () => {
    const events = await collectEvents(parallelToolStream());

    const starts = events.filter((e) => e.event === "content_block_start");
    const toolStarts = starts.filter(
      (e) => (e.data.content_block as Record<string, unknown> | undefined)?.type === "tool_use",
    );

    expect(toolStarts).toHaveLength(2);

    const indices = toolStarts.map((e) => e.data.index);
    // Each tool_use block must occupy its own content block index; colliding
    // indices corrupt the Anthropic stream (deltas mix, one tool call is lost).
    expect(new Set(indices).size).toBe(2);
  });

  it("emits stop for the same index each block was started on", async () => {
    const events = await collectEvents(parallelToolStream());

    const startIdx = events
      .filter((e) => e.event === "content_block_start")
      .filter((e) => (e.data.content_block as Record<string, unknown> | undefined)?.type === "tool_use")
      .map((e) => e.data.index)
      .sort();
    const stopIdx = events
      .filter((e) => e.event === "content_block_stop")
      .map((e) => e.data.index)
      .sort();

    // Every started block index must be closed exactly once, no phantom indices.
    expect(stopIdx).toEqual(startIdx);
  });

  it("routes interleaved argument deltas to each tool's own block", async () => {
    const events = await collectEvents([
      createCreated("resp_par"),
      createInProgress("resp_par"),
      createFunctionCallStart("call_a", "tool_a"),
      createFunctionCallStart("call_b", "tool_b"),
      createFunctionCallDelta("call_a", '{"x":1}'),
      createFunctionCallDelta("call_b", '{"y":2}'),
      createFunctionCallDone("call_a", "tool_a", '{"x":1}'),
      createFunctionCallDone("call_b", "tool_b", '{"y":2}'),
      createCompleted("resp_par", { input_tokens: 10, output_tokens: 5 }),
    ]);

    // Map each tool_use block index → its callId via content_block_start.
    const indexToCall = new Map<unknown, string>();
    for (const e of events) {
      if (e.event !== "content_block_start") continue;
      const cb = e.data.content_block as Record<string, unknown> | undefined;
      if (cb?.type === "tool_use") indexToCall.set(e.data.index, cb.id as string);
    }

    // Accumulate the partial_json delivered to each block index.
    const argsByCall = new Map<string, string>();
    for (const e of events) {
      if (e.event !== "content_block_delta") continue;
      const delta = e.data.delta as Record<string, unknown>;
      if (delta?.type !== "input_json_delta") continue;
      const call = indexToCall.get(e.data.index);
      if (!call) continue;
      argsByCall.set(call, (argsByCall.get(call) ?? "") + (delta.partial_json as string));
    }

    // tool_a's args must land in tool_a's block, tool_b's in tool_b's — no mixing.
    expect(argsByCall.get("call_a")).toBe('{"x":1}');
    expect(argsByCall.get("call_b")).toBe('{"y":2}');
  });

  it("reports stop_reason tool_use even when a done arrives without a start", () => {
    return collectEvents([
      createCreated("resp_orphan"),
      createInProgress("resp_orphan"),
      // No createFunctionCallStart — the done-without-start defensive path.
      createFunctionCallDone("call_x", "tool_x", '{"a":1}'),
      createCompleted("resp_orphan", { input_tokens: 10, output_tokens: 5 }),
    ]).then((events) => {
      const toolStart = events.find(
        (e) => e.event === "content_block_start"
          && (e.data.content_block as Record<string, unknown> | undefined)?.type === "tool_use",
      );
      expect(toolStart).toBeDefined();

      const messageDelta = events.find((e) => e.event === "message_delta");
      const delta = messageDelta?.data.delta as Record<string, unknown> | undefined;
      expect(delta?.stop_reason).toBe("tool_use");
    });
  });
});
