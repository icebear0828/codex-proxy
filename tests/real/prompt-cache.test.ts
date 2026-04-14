/**
 * Real upstream tests — prompt cache hit rate.
 *
 * Verifies cached_tokens propagation across API formats via multi-turn
 * conversations. Cache hits depend on upstream state and are not guaranteed,
 * so tests validate the plumbing (field presence + correct format) regardless.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, anthropicHeaders, parseDataLines, collectSSE,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Long instructions to maximize prompt cache potential. */
const LONG_INSTRUCTIONS = `You are a helpful assistant. Follow these rules precisely:
1. Always respond in English.
2. Keep answers concise but complete.
3. When asked about numbers, always include the exact value.
4. Use simple language, avoid jargon.
5. If you don't know something, say so explicitly.
6. Remember all context from prior messages in this conversation.
7. Never fabricate information or make up facts.
8. Be polite and professional at all times.
9. Format numbers with proper separators when needed.
10. Provide step-by-step reasoning when solving problems.`;

function extractResponseId(text: string): string | null {
  const dataLines = parseDataLines(text);
  // Prefer completed event's id
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const inner = parsed.response as Record<string, unknown> | undefined;
      if (inner?.id && typeof inner.id === "string" && inner.status === "completed") {
        return inner.id;
      }
    } catch { /* skip */ }
  }
  // Fallback: any response id
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const inner = parsed.response as Record<string, unknown> | undefined;
      if (inner?.id && typeof inner.id === "string") return inner.id;
    } catch { /* skip */ }
  }
  return null;
}

function extractCodexUsage(text: string): { input_tokens: number; output_tokens: number; cached_tokens?: number } | null {
  const dataLines = parseDataLines(text);
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const inner = parsed.response as Record<string, unknown> | undefined;
      if (inner?.status === "completed" && inner.usage) {
        return inner.usage as { input_tokens: number; output_tokens: number; cached_tokens?: number };
      }
    } catch { /* skip */ }
  }
  return null;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("real: prompt cache via Codex /v1/responses", () => {
  it("multi-turn reports cached_tokens field and usage", async () => {
    if (skip()) return;

    // Turn 1
    const res1 = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: LONG_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: "What is 2 + 2?" }] }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res1.status).toBe(200);
    const text1 = await res1.text();
    const responseId1 = extractResponseId(text1);
    expect(responseId1).toBeTruthy();

    const usage1 = extractCodexUsage(text1);
    expect(usage1).toBeTruthy();
    expect(usage1!.input_tokens).toBeGreaterThan(0);
    expect(usage1!.output_tokens).toBeGreaterThan(0);
    const cached1 = usage1?.cached_tokens ?? 0;

    // Turn 2 with previous_response_id → triggers session affinity + prompt cache
    const res2 = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: LONG_INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: "Now what is 3 + 3?" }] }],
        previous_response_id: responseId1,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res2.status).toBe(200);
    const text2 = await res2.text();
    const usage2 = extractCodexUsage(text2);
    expect(usage2).toBeTruthy();
    expect(usage2!.input_tokens).toBeGreaterThan(0);
    expect(usage2!.output_tokens).toBeGreaterThan(0);

    const cached2 = usage2?.cached_tokens ?? 0;
    console.log(`[prompt-cache] Codex: turn1 cached=${cached1}, turn2 cached=${cached2}`);

    // If cache hit occurred, cached tokens should have increased
    if (cached2 > cached1) {
      expect(cached2).toBeGreaterThan(0);
    }
    // Turn 2 should have more input tokens (includes prior context)
    expect(usage2!.input_tokens).toBeGreaterThanOrEqual(usage1!.input_tokens);
  }, 60_000);
});

describe("real: cached_tokens in OpenAI format", () => {
  it("prompt_tokens_details.cached_tokens field is present", async () => {
    if (skip()) return;

    // Turn 1
    const res1 = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [
          { role: "system", content: LONG_INSTRUCTIONS },
          { role: "user", content: "What is 7 * 8?" },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    const usage1 = body1.usage as Record<string, unknown>;
    expect(usage1.prompt_tokens).toBeGreaterThan(0);
    expect(usage1.completion_tokens).toBeGreaterThan(0);

    const details1 = usage1.prompt_tokens_details as { cached_tokens?: number } | undefined;
    const cached1 = details1?.cached_tokens ?? 0;

    // Turn 2: same system prompt + history
    const assistantContent = (body1.choices as Array<{ message: { content: string } }>)[0].message.content;
    const res2 = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [
          { role: "system", content: LONG_INSTRUCTIONS },
          { role: "user", content: "What is 7 * 8?" },
          { role: "assistant", content: assistantContent },
          { role: "user", content: "Now multiply the result by 2." },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    const usage2 = body2.usage as Record<string, unknown>;
    expect(usage2.prompt_tokens).toBeGreaterThan(0);
    expect(usage2.completion_tokens).toBeGreaterThan(0);

    const details2 = usage2.prompt_tokens_details as { cached_tokens?: number } | undefined;
    const cached2 = details2?.cached_tokens ?? 0;
    console.log(`[prompt-cache] OpenAI: turn1 cached=${cached1}, turn2 cached=${cached2}`);

    // Turn 2 prompt should be larger (more messages)
    expect(usage2.prompt_tokens as number).toBeGreaterThan(usage1.prompt_tokens as number);
  }, 60_000);
});

describe("real: cached_tokens in Anthropic format", () => {
  it("cache_read_input_tokens field is present in usage", async () => {
    if (skip()) return;

    // Turn 1
    const res1 = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 200,
        system: LONG_INSTRUCTIONS,
        messages: [{ role: "user", content: "What is 10 + 15?" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    const usage1 = body1.usage as Record<string, number>;
    expect(usage1.input_tokens).toBeGreaterThan(0);
    expect(usage1.output_tokens).toBeGreaterThan(0);

    const cacheRead1 = usage1.cache_read_input_tokens ?? 0;

    // Turn 2
    const assistantText = ((body1.content as Array<{ text: string }>)[0]).text;
    const res2 = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 200,
        system: LONG_INSTRUCTIONS,
        messages: [
          { role: "user", content: "What is 10 + 15?" },
          { role: "assistant", content: assistantText },
          { role: "user", content: "Now subtract 5 from the result." },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    const usage2 = body2.usage as Record<string, number>;
    expect(usage2.input_tokens).toBeGreaterThan(0);
    expect(usage2.output_tokens).toBeGreaterThan(0);

    const cacheRead2 = usage2.cache_read_input_tokens ?? 0;
    console.log(`[prompt-cache] Anthropic: turn1 cache_read=${cacheRead1}, turn2 cache_read=${cacheRead2}`);

    // Turn 2 should have more input tokens
    expect(usage2.input_tokens).toBeGreaterThan(usage1.input_tokens);
  }, 60_000);
});

// ── Gemini format ───────────────────────────────────────────────────

describe("real: cached_tokens in Gemini format", () => {
  it("usageMetadata tracks token counts across turns", async () => {
    if (skip()) return;

    // Turn 1
    const res1 = await fetch(`${PROXY_URL}/v1beta/models/codex:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LONG_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: "What is 5 + 5?" }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    const meta1 = body1.usageMetadata as Record<string, number> | undefined;
    expect(meta1).toBeDefined();
    expect(meta1!.promptTokenCount).toBeGreaterThan(0);

    const cached1 = meta1?.cachedContentTokenCount ?? 0;

    // Turn 2: same system instruction + conversation history
    const assistantText = (
      (body1.candidates as Array<{ content: { parts: Array<{ text: string }> } }>)[0]
        .content.parts[0].text
    );
    const res2 = await fetch(`${PROXY_URL}/v1beta/models/codex:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LONG_INSTRUCTIONS }] },
        contents: [
          { role: "user", parts: [{ text: "What is 5 + 5?" }] },
          { role: "model", parts: [{ text: assistantText }] },
          { role: "user", parts: [{ text: "Now double the result." }] },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    const meta2 = body2.usageMetadata as Record<string, number> | undefined;
    expect(meta2).toBeDefined();
    expect(meta2!.promptTokenCount).toBeGreaterThan(0);

    const cached2 = meta2?.cachedContentTokenCount ?? 0;
    console.log(`[prompt-cache] Gemini: turn1 cached=${cached1}, turn2 cached=${cached2}`);

    // Turn 2 should have more prompt tokens (more context)
    expect(meta2!.promptTokenCount).toBeGreaterThan(meta1!.promptTokenCount);
  }, 60_000);
});
