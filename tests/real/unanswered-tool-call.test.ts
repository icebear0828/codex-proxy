/**
 * Real upstream test — validates the fix for "No tool output found for
 * function call call_X" upstream error path.
 *
 * Two flows:
 *  1. Happy path (regression guard): multi-tool parallel call_use →
 *     complete tool_results follow-up should succeed.
 *  2. Recovery path: when client's continuation skips one of the previous
 *     turn's function_calls, the proxy's reverse-check (`unanswered_tool_calls`)
 *     should disable implicit resume + replay full history; if upstream still
 *     rejects (true client mismatch), Layer 2 catch must surface a graceful
 *     error rather than spamming logs.
 *
 * Run with: npm run test:real -- unanswered-tool-call
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL,
  checkProxy, skip, anthropicHeaders,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

const TOOL_TIMEOUT = 60_000;

const TOOLS = [
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
  {
    name: "get_time",
    description: "Get the current time in a location",
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
];

const PARALLEL_PROMPT =
  "I need to know both the weather AND the current time in Tokyo. Call BOTH get_weather and get_time IN PARALLEL in a single response.";

interface AnthropicContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string;
}

async function sendMessages(
  messages: AnthropicMessage[],
): Promise<{ status: number; body: AnthropicResponse | { type: string; error: { message: string } } }> {
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "codex",
      max_tokens: 1024,
      messages,
      tools: TOOLS,
      stream: false,
    }),
    signal: AbortSignal.timeout(TOOL_TIMEOUT),
  });
  const body = await res.json();
  return { status: res.status, body: body as AnthropicResponse };
}

describe("real: parallel tool_use + complete follow-up (regression guard)", () => {
  it("3 iterations: full parallel tool flow round-trips cleanly", async () => {
    if (skip()) return;

    for (let iteration = 1; iteration <= 3; iteration++) {
      // Turn 1: model emits parallel tool_use blocks.
      const turn1 = await sendMessages([
        { role: "user", content: PARALLEL_PROMPT },
      ]);
      expect(turn1.status, `turn1 iteration ${iteration}`).toBe(200);
      const r1 = turn1.body as AnthropicResponse;

      const toolUses = r1.content.filter((b) => b.type === "tool_use");
      // Some turns the model may serialize calls instead of paralleling them.
      // Skip iterations that didn't actually parallel — they don't exercise
      // the multi-call code path. Re-roll up to a few times.
      if (toolUses.length < 2) {
        iteration--;
        continue;
      }

      // Turn 2: complete tool_results for ALL tool_uses (the well-formed case).
      const turn2 = await sendMessages([
        { role: "user", content: PARALLEL_PROMPT },
        { role: "assistant", content: r1.content },
        {
          role: "user",
          content: toolUses.map((tu) => ({
            type: "tool_result",
            tool_use_id: tu.id!,
            content: tu.name === "get_weather" ? "Sunny, 22°C" : "14:30 JST",
          })) as AnthropicContentBlock[],
        },
      ]);
      expect(turn2.status, `turn2 iteration ${iteration}`).toBe(200);
      const r2 = turn2.body as AnthropicResponse;
      // Should now produce text output
      expect(r2.content.some((b) => b.type === "text")).toBe(true);
    }
  }, TOOL_TIMEOUT * 6);
});

describe("real: partial tool_result triggers proxy recovery path", () => {
  it("missing one tool_result returns a structured error, not a stream crash", async () => {
    if (skip()) return;

    // Turn 1: get parallel tool_use IDs.
    let toolUses: AnthropicContentBlock[] = [];
    let turn1Content: AnthropicContentBlock[] = [];
    for (let attempt = 0; attempt < 3 && toolUses.length < 2; attempt++) {
      const turn1 = await sendMessages([
        { role: "user", content: PARALLEL_PROMPT },
      ]);
      if (turn1.status !== 200) continue;
      const r1 = turn1.body as AnthropicResponse;
      toolUses = r1.content.filter((b) => b.type === "tool_use");
      turn1Content = r1.content;
    }
    if (toolUses.length < 2) {
      console.warn("[real] could not get parallel tool_use, skipping");
      return;
    }

    // Turn 2: deliberately answer ONLY the first tool_use, omit the second.
    const turn2 = await sendMessages([
      { role: "user", content: PARALLEL_PROMPT },
      { role: "assistant", content: turn1Content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUses[0].id!,
            content: "Sunny, 22°C",
          },
        ] as AnthropicContentBlock[],
      },
    ]);

    // Layer 1 reverse-check disables implicit resume → full replay still has
    // the orphan function_call → upstream rejects with 400 "No tool output
    // found...". Layer 2 strip+retry can't fabricate the missing tool_result,
    // so the final outcome is a structured 4xx surfaced to the client (NOT a
    // 502 fallback or a stream crash). 5xx indicates the proxy lost the real
    // upstream status somewhere in the SSE/collect path.
    expect(turn2.status).toBeGreaterThanOrEqual(400);
    expect(turn2.status).toBeLessThan(500);
    const errBody = turn2.body as { error?: { message?: string } };
    const msg = errBody.error?.message ?? "";
    expect(msg.toLowerCase()).toContain("no tool output found for function call");
  }, TOOL_TIMEOUT * 4);
});
