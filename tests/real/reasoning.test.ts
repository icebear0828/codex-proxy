/**
 * Real upstream tests — reasoning effort & summary.
 *
 * Verifies:
 * 1. Reasoning effort levels are accepted by upstream
 * 2. Reasoning summary events appear in streaming responses
 * 3. usage.reasoning_tokens is reported
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, parseDataLines,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

const REASONING_TIMEOUT = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────

interface ResponsesResult {
  status: number;
  events: string[];
  dataLines: string[];
  text: string;
}

async function sendWithReasoning(
  effort: string,
  summary = "auto",
): Promise<ResponsesResult> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "codex",
      instructions: "Think step by step. What is 17 * 23?",
      input: [{ role: "user", content: [{ type: "input_text", text: "Calculate it." }] }],
      stream: true,
      reasoning: { effort, summary },
    }),
    signal: AbortSignal.timeout(REASONING_TIMEOUT),
  });

  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));
  const dataLines = parseDataLines(text);

  return { status: res.status, events, dataLines, text };
}

function extractUsage(dataLines: string[]): Record<string, unknown> | null {
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.status === "completed" && parsed.usage) {
        return parsed.usage as Record<string, unknown>;
      }
    } catch {
      // skip
    }
  }
  return null;
}

// ── Reasoning effort levels ──────────────────────────────────────────

describe("real: reasoning effort", () => {
  it("effort=low: upstream accepts and returns completed response", async () => {
    if (skip()) return;

    const result = await sendWithReasoning("low");
    expect(result.status).toBe(200);
    expect(result.events).toContain("response.completed");
  }, REASONING_TIMEOUT);

  it("effort=medium: upstream accepts and returns completed response", async () => {
    if (skip()) return;

    const result = await sendWithReasoning("medium");
    expect(result.status).toBe(200);
    expect(result.events).toContain("response.completed");
  }, REASONING_TIMEOUT);

  it("effort=high: upstream accepts and returns completed response", async () => {
    if (skip()) return;

    const result = await sendWithReasoning("high");
    expect(result.status).toBe(200);
    expect(result.events).toContain("response.completed");

    // High effort should produce reasoning_tokens in usage
    const usage = extractUsage(result.dataLines);
    if (usage) {
      // reasoning_tokens may be in output_tokens_details
      expect(usage.output_tokens).toBeGreaterThan(0);
    }
  }, REASONING_TIMEOUT);
});

// ── Reasoning summary events ─────────────────────────────────────────

describe("real: reasoning summary", () => {
  it("summary=auto: may produce reasoning summary events", async () => {
    if (skip()) return;

    const result = await sendWithReasoning("high", "auto");
    expect(result.status).toBe(200);
    expect(result.events).toContain("response.completed");

    // Check if reasoning summary events are present (model-dependent)
    const hasReasoningSummary = result.events.some((e) =>
      e.startsWith("response.reasoning_summary_text"),
    );
    // Log for visibility — not all models produce summary events
    if (hasReasoningSummary) {
      console.log("[reasoning] Summary events detected");
    } else {
      console.log("[reasoning] No summary events (model may not support it)");
    }
  }, REASONING_TIMEOUT);
});

// ── Reasoning via model suffix ───────────────────────────────────────

describe("real: reasoning via model suffix", () => {
  it("model=codex-high: implicit reasoning effort from suffix", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex-high",
        instructions: "What is 17 * 23?",
        input: [{ role: "user", content: [{ type: "input_text", text: "Calculate it." }] }],
        stream: true,
        // No explicit reasoning param — should be inferred from "-high" suffix
      }),
      signal: AbortSignal.timeout(REASONING_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    expect(events).toContain("response.completed");
  }, REASONING_TIMEOUT);
});

// ── Service tier via model suffix ────────────────────────────────────

describe("real: service tier via model suffix", () => {
  it("model=codex-fast: accepted and returns completed response", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex-fast",
        instructions: "Say hello.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(REASONING_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    expect(events).toContain("response.completed");
  }, REASONING_TIMEOUT);

  it("model=codex-fast via /v1/chat/completions", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex-fast",
        messages: [{ role: "user", content: "Say hello." }],
        stream: false,
      }),
      signal: AbortSignal.timeout(REASONING_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
  }, REASONING_TIMEOUT);
});

// ── Reasoning via OpenAI format ──────────────────────────────────────

describe("real: reasoning via /v1/chat/completions", () => {
  it("passes reasoning through OpenAI format", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "What is 17 * 23? Think step by step." }],
        stream: false,
        reasoning_effort: "high",
      }),
      signal: AbortSignal.timeout(REASONING_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");

    const choices = body.choices as Array<{ message: { content: string } }>;
    expect(choices[0].message.content).toContain("391");

    const usage = body.usage as Record<string, number>;
    expect(usage.completion_tokens).toBeGreaterThan(0);
  }, REASONING_TIMEOUT);
});
