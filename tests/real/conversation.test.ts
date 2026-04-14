/**
 * Real upstream tests — multi-turn conversation & session affinity.
 *
 * Verifies:
 * 1. First request returns a response_id
 * 2. Second request with previous_response_id succeeds (triggers WebSocket transport)
 * 3. Conversation continuity — assistant references prior context
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, collectSSEEvents, parseDataLines,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── Helpers ──────────────────────────────────────────────────────────

interface CodexResponse {
  id: string;
  status: string;
  output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  usage: Record<string, number>;
}

/** Send a /v1/responses request (non-streaming) and return parsed body. */
async function sendResponses(
  body: Record<string, unknown>,
): Promise<{ status: number; body: CodexResponse }> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = await res.json() as CodexResponse;
  return { status: res.status, body: json };
}

/** Send a streaming /v1/responses request and extract response_id + events. */
async function sendResponsesStreaming(
  body: Record<string, unknown>,
): Promise<{ status: number; responseId: string | null; events: string[]; text: string }> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));

  // Extract response_id from response.created event (nested in response.id)
  let responseId: string | null = null;
  const dataLines = parseDataLines(text);
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // response.created/response.completed carry { response: { id, status } }
      const inner = parsed.response as Record<string, unknown> | undefined;
      if (inner?.id && typeof inner.id === "string") {
        responseId = inner.id as string;
        // prefer completed event's id, but created works too
        if (inner.status === "completed") break;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return { status: res.status, responseId, events, text };
}

// ── Multi-turn conversation ──────────────────────────────────────────

describe("real: multi-turn conversation", () => {
  it("first turn returns a response with id", async () => {
    if (skip()) return;

    const { status, body } = await sendResponses({
      model: "codex",
      instructions: "You are a helpful assistant. Remember what the user tells you.",
      input: [{ role: "user", content: [{ type: "input_text", text: "My favorite color is blue. Remember this." }] }],
      stream: false,
    });

    expect(status).toBe(200);
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.status).toBe("completed");
  }, 60_000);

  it("second turn with previous_response_id continues conversation", async () => {
    if (skip()) return;

    // Turn 1: establish context
    const turn1 = await sendResponsesStreaming({
      model: "codex",
      instructions: "You are a helpful assistant. Remember everything the user says.",
      input: [{ role: "user", content: [{ type: "input_text", text: "My secret number is 42. Remember this." }] }],
    });

    expect(turn1.status).toBe(200);
    expect(turn1.events).toContain("response.completed");
    expect(turn1.responseId).toBeTruthy();

    // Turn 2: reference previous context
    const turn2 = await sendResponsesStreaming({
      model: "codex",
      instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "What is my secret number? Reply with just the number." }] }],
      previous_response_id: turn1.responseId,
    });

    expect(turn2.status).toBe(200);
    expect(turn2.events).toContain("response.completed");

    // Verify the assistant remembers the context
    const dataLines = parseDataLines(turn2.text);
    const fullText = dataLines.join(" ");
    expect(fullText).toContain("42");
  }, 60_000);
});

// ── Session affinity via OpenAI format ───────────────────────────────

describe("real: multi-turn via /v1/chat/completions", () => {
  it("multi-message conversation maintains context", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [
          { role: "user", content: "My secret word is 'pineapple'. Remember it." },
          { role: "assistant", content: "Got it! Your secret word is 'pineapple'. I'll remember that." },
          { role: "user", content: "What is my secret word? Reply with just the word." },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const choices = body.choices as Array<{ message: { content: string } }>;
    const reply = choices[0].message.content.toLowerCase();
    expect(reply).toContain("pineapple");
  }, TIMEOUT);
});
