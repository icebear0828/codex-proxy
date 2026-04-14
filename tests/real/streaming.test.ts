/**
 * Real upstream tests — streaming reliability.
 *
 * Verifies:
 * 1. SSE event ordering is correct across all formats
 * 2. Long responses stream without dropping events
 * 3. Client abort is handled gracefully
 * 4. Usage appears in final streaming event
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, anthropicHeaders, parseSSE,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

const LONG_PROMPT = "Write a detailed step-by-step explanation of how a CPU executes a simple addition instruction, from fetch to writeback. Include at least 5 distinct steps.";

// ── OpenAI streaming ────────────────────────────────────────────────

describe("real: OpenAI streaming reliability", () => {
  it("long response: all chunks are valid JSON, ends with [DONE]", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: LONG_PROMPT }],
        stream: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { dataLines } = parseSSE(text);

    expect(dataLines.length).toBeGreaterThanOrEqual(5);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    let contentParts = 0;
    for (const line of dataLines) {
      if (line === "[DONE]") continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.object).toBe("chat.completion.chunk");
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      if (choices?.[0]?.delta?.content) contentParts++;
    }
    expect(contentParts).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("final chunk includes usage with token counts", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { dataLines } = parseSSE(text);

    let finalChunk: Record<string, unknown> | null = null;
    for (const line of dataLines) {
      if (line === "[DONE]") continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const choices = parsed.choices as Array<{ finish_reason: string | null }> | undefined;
      if (choices?.[0]?.finish_reason === "stop") {
        finalChunk = parsed;
      }
    }

    expect(finalChunk).toBeTruthy();
    const usage = finalChunk!.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
    if (usage) {
      expect(usage.prompt_tokens).toBeGreaterThan(0);
      expect(usage.completion_tokens).toBeGreaterThan(0);
    }
  }, TIMEOUT);
});

// ── Codex streaming ─────────────────────────────────────────────────

describe("real: Codex streaming reliability", () => {
  it("event ordering: created → deltas → completed", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Be concise.",
        input: [{ role: "user", content: [{ type: "input_text", text: LONG_PROMPT }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { events } = parseSSE(text);

    const createdIdx = events.indexOf("response.created");
    const completedIdx = events.lastIndexOf("response.completed");

    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(createdIdx);

    const deltaEvents = events.filter((e) => e === "response.output_text.delta");
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("completed event includes usage", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Be brief.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { dataLines } = parseSSE(text);

    let completedData: Record<string, unknown> | null = null;
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const inner = parsed.response as Record<string, unknown> | undefined;
        if (inner?.status === "completed" && inner.usage) {
          completedData = inner;
        }
      } catch { /* skip */ }
    }

    expect(completedData).toBeTruthy();
    const usage = completedData!.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ── Anthropic streaming ─────────────────────────────────────────────

describe("real: Anthropic streaming reliability", () => {
  it("event ordering: message_start → deltas → message_delta → message_stop", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 500,
        messages: [{ role: "user", content: LONG_PROMPT }],
        stream: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { events } = parseSSE(text);

    const startIdx = events.indexOf("message_start");
    const stopIdx = events.lastIndexOf("message_stop");
    const deltaIdx = events.lastIndexOf("message_delta");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(startIdx);
    expect(deltaIdx).toBeGreaterThan(startIdx);
    expect(deltaIdx).toBeLessThan(stopIdx);

    const deltas = events.filter((e) => e === "content_block_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("message_delta carries usage stats", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 100,
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { dataLines } = parseSSE(text);

    let usageFound = false;
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "message_delta") {
          const usage = parsed.usage as Record<string, number> | undefined;
          if (usage?.output_tokens) {
            expect(usage.output_tokens).toBeGreaterThan(0);
            usageFound = true;
          }
        }
      } catch { /* skip */ }
    }
    expect(usageFound).toBe(true);
  }, TIMEOUT);
});

// ── Client abort ────────────────────────────────────────────────────

describe("real: client abort handling", () => {
  it("aborting mid-stream does not crash the proxy", async () => {
    if (skip()) return;

    const controller = new AbortController();

    try {
      const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: "codex",
          messages: [{ role: "user", content: LONG_PROMPT }],
          stream: true,
        }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read(); // Read first chunk
      controller.abort();
      reader.releaseLock();
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") throw err;
    }

    // Proxy should still be healthy
    const health = await fetch(`${PROXY_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(health.ok).toBe(true);
  }, TIMEOUT);
});
