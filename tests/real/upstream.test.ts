/**
 * Real upstream integration tests — basic format verification.
 *
 * Verifies all 4 API formats (OpenAI, Anthropic, Codex, Gemini) in both
 * streaming and non-streaming modes against a running proxy.
 *
 * Run with: npm run test:real
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, anthropicHeaders, collectSSE,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── /v1/chat/completions ─────────────────────────────────────────────

describe("real: /v1/chat/completions", () => {
  it("non-streaming: returns valid chat completion", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");

    const choices = body.choices as Array<{ message: { content: string } }>;
    expect(choices.length).toBeGreaterThanOrEqual(1);
    expect(typeof choices[0].message.content).toBe("string");
    expect(choices[0].message.content.length).toBeGreaterThan(0);

    const usage = body.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
  }, TIMEOUT);

  it("streaming: returns SSE chunks ending with [DONE]", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const dataLines = await collectSSE(res);
    expect(dataLines.length).toBeGreaterThanOrEqual(2);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    // First data chunk is valid JSON with chat.completion.chunk structure
    const first = JSON.parse(dataLines[0]) as Record<string, unknown>;
    expect(first.object).toBe("chat.completion.chunk");
  }, TIMEOUT);
});

// ── /v1/messages (Anthropic format) ──────────────────────────────────

describe("real: /v1/messages", () => {
  it("non-streaming: returns valid Anthropic message", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 100,
        messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");

    const content = body.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text.length).toBeGreaterThan(0);

    const usage = body.usage as Record<string, number>;
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  }, TIMEOUT);

  it("streaming: returns Anthropic SSE events", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 100,
        messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // Anthropic SSE uses "event: " prefix lines
    const eventTypes = text.split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("message_stop");
  }, TIMEOUT);
});

// ── /v1/responses (Codex passthrough) ────────────────────────────────

describe("real: /v1/responses", () => {
  it("streaming: returns Codex SSE events", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Reply with exactly one word: hello",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const eventTypes = text.split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    expect(eventTypes).toContain("response.created");
    expect(eventTypes).toContain("response.completed");
  }, TIMEOUT);

  it("non-streaming: returns Codex JSON response", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Reply with exactly one word: hello",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(body.status).toBe("completed");

    const output = body.output as Array<Record<string, unknown>>;
    expect(output.length).toBeGreaterThanOrEqual(1);

    const usage = body.usage as Record<string, number>;
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ── /v1beta/models (Gemini format) ───────────────────────────────────

describe("real: Gemini endpoints", () => {
  it("streamGenerateContent: NDJSON streaming", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1beta/models/codex:streamGenerateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: hello" }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const dataLines = await collectSSE(res);
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    const first = JSON.parse(dataLines[0]) as Record<string, unknown>;
    expect(first.candidates).toBeDefined();
  }, TIMEOUT);

  it("generateContent: JSON response", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1beta/models/codex:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: hello" }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.candidates).toBeDefined();

    const candidates = body.candidates as Array<Record<string, unknown>>;
    const content = candidates[0].content as { parts: Array<{ text: string }> };
    expect(content.parts[0].text.length).toBeGreaterThan(0);

    expect(body.usageMetadata).toBeDefined();
  }, TIMEOUT);
});
