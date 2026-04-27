/**
 * Regression tests for cache_tokens extraction in non-Codex upstream adapters.
 *
 * Before this fix, OpenAI / Anthropic / Gemini upstream adapters all hardcoded
 * `input_tokens_details: {}` in their synthesized response.completed event,
 * which caused the dashboard cache hit rate to read 0% for any traffic going
 * through those backends. The fix reads the native cache field
 * (prompt_tokens_details.cached_tokens / cache_read_input_tokens /
 * cachedContentTokenCount) and surfaces it under the standard Codex shape.
 */

import { describe, it, expect } from "vitest";
import { OpenAIUpstream } from "@src/proxy/openai-upstream.js";
import { AnthropicUpstream } from "@src/proxy/anthropic-upstream.js";
import { GeminiUpstream } from "@src/proxy/gemini-upstream.js";
import type { CodexSSEEvent } from "@src/proxy/codex-types.js";

function makeResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(gen: AsyncGenerator<CodexSSEEvent>): Promise<CodexSSEEvent[]> {
  const out: CodexSSEEvent[] = [];
  for await (const evt of gen) out.push(evt);
  return out;
}

function findCompleted(events: CodexSSEEvent[]): Record<string, unknown> | null {
  for (const e of events) {
    if (e.event === "response.completed" && typeof e.data === "object" && e.data !== null) {
      const d = e.data as Record<string, unknown>;
      const resp = d.response as Record<string, unknown> | undefined;
      const usage = resp?.usage as Record<string, unknown> | undefined;
      return usage ?? null;
    }
  }
  return null;
}

describe("OpenAIUpstream — cache_tokens extraction", () => {
  it("surfaces prompt_tokens_details.cached_tokens to input_tokens_details.cached_tokens", async () => {
    // OpenAI ChatCompletions SSE: stream_options.include_usage=true puts usage on the last chunk.
    const sse = [
      "data: " + JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hi" } }],
      }),
      "",
      "data: " + JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 1200 },
        },
      }),
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const upstream = new OpenAIUpstream("openai", "fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage).not.toBeNull();
    expect(usage?.input_tokens).toBe(1500);
    expect(usage?.output_tokens).toBe(30);
    expect((usage?.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(1200);
  });

  it("emits empty input_tokens_details when upstream omits the cache field", async () => {
    const sse = [
      "data: " + JSON.stringify({
        id: "chatcmpl-2",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const upstream = new OpenAIUpstream("openai", "fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage?.input_tokens_details).toEqual({});
  });
});

describe("AnthropicUpstream — cache_tokens extraction", () => {
  it("surfaces cache_read_input_tokens (from message_start) to input_tokens_details.cached_tokens", async () => {
    const sse = [
      "event: message_start",
      "data: " + JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_abc",
          usage: { input_tokens: 800, cache_read_input_tokens: 600 },
        },
      }),
      "",
      "event: content_block_delta",
      "data: " + JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      "",
      "event: message_delta",
      "data: " + JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 25 },
      }),
      "",
      "event: message_stop",
      "data: " + JSON.stringify({ type: "message_stop" }),
      "",
    ].join("\n");

    const upstream = new AnthropicUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage?.input_tokens).toBe(800);
    expect(usage?.output_tokens).toBe(25);
    expect((usage?.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(600);
  });

  it("prefers cache_read_input_tokens from message_delta when message_start lacks it", async () => {
    const sse = [
      "event: message_start",
      "data: " + JSON.stringify({
        type: "message_start",
        message: { id: "msg_def", usage: { input_tokens: 500 } },
      }),
      "",
      "event: message_delta",
      "data: " + JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 12, cache_read_input_tokens: 320 },
      }),
      "",
      "event: message_stop",
      "data: " + JSON.stringify({ type: "message_stop" }),
      "",
    ].join("\n");

    const upstream = new AnthropicUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect((usage?.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(320);
  });

  it("preserves message_start cache value when message_delta re-emits zero (Math.max guard)", async () => {
    // Defensive: if a future Anthropic API change causes message_delta to emit
    // cache_read_input_tokens: 0 after message_start reported a real hit, we
    // must not lose the start value.
    const sse = [
      "event: message_start",
      "data: " + JSON.stringify({
        type: "message_start",
        message: { id: "msg_g", usage: { input_tokens: 600, cache_read_input_tokens: 480 } },
      }),
      "",
      "event: message_delta",
      "data: " + JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 18, cache_read_input_tokens: 0 },
      }),
      "",
      "event: message_stop",
      "data: " + JSON.stringify({ type: "message_stop" }),
      "",
    ].join("\n");

    const upstream = new AnthropicUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect((usage?.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(480);
  });

  it("emits empty input_tokens_details when no cache field is present", async () => {
    const sse = [
      "event: message_start",
      "data: " + JSON.stringify({
        type: "message_start",
        message: { id: "msg_x", usage: { input_tokens: 100 } },
      }),
      "",
      "event: message_delta",
      "data: " + JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
      "",
      "event: message_stop",
      "data: " + JSON.stringify({ type: "message_stop" }),
      "",
    ].join("\n");

    const upstream = new AnthropicUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage?.input_tokens_details).toEqual({});
  });
});

describe("GeminiUpstream — cache_tokens extraction", () => {
  it("surfaces cachedContentTokenCount to input_tokens_details.cached_tokens", async () => {
    // Gemini SSE: each data line is a GenerateContentResponse JSON.
    const sse = [
      "data: " + JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 750,
        },
      }),
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const upstream = new GeminiUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage?.input_tokens).toBe(1000);
    expect(usage?.output_tokens).toBe(20);
    expect((usage?.input_tokens_details as Record<string, unknown>).cached_tokens).toBe(750);
  });

  it("emits empty input_tokens_details when upstream omits cachedContentTokenCount", async () => {
    const sse = [
      "data: " + JSON.stringify({
        candidates: [{ content: { parts: [{ text: "x" }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
      }),
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const upstream = new GeminiUpstream("fake-key");
    const events = await collect(upstream.parseStream(makeResponse(sse)));
    const usage = findCompleted(events);
    expect(usage?.input_tokens_details).toEqual({});
  });
});
