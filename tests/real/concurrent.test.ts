/**
 * Real upstream tests — concurrent request isolation.
 *
 * Verifies:
 * 1. Multiple parallel requests all return complete, valid responses
 * 2. No response corruption or cross-contamination
 * 3. Usage tracking is accurate under concurrent load
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers,
  getActiveAccounts, resetAllUsage,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── Types ──────────────────────────────────────────────────────────

interface ChatCompletion {
  id: string;
  object: string;
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function sendUniqueRequest(n: number): Promise<{
  status: number;
  id: string;
  content: string;
  usage: ChatCompletion["usage"];
}> {
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "codex",
      messages: [{ role: "user", content: `What is ${n} * ${n}? Reply ONLY with the numeric result, nothing else.` }],
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json() as ChatCompletion;
  return {
    status: res.status,
    id: body.id,
    content: body.choices?.[0]?.message?.content ?? "",
    usage: body.usage,
  };
}

async function sendStreamingRequest(n: number): Promise<{
  status: number;
  chunks: number;
  hasDone: boolean;
  text: string;
}> {
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "codex",
      messages: [{ role: "user", content: `What is ${n} + ${n}? Reply ONLY with the numeric result, nothing else.` }],
      stream: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const raw = await res.text();
  const dataLines = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const textParts: string[] = [];
  for (const line of dataLines) {
    if (line === "[DONE]") continue;
    try {
      const chunk = JSON.parse(line) as Record<string, unknown>;
      const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
      const delta = choices?.[0]?.delta?.content;
      if (delta) textParts.push(delta);
    } catch { /* skip */ }
  }
  return {
    status: res.status,
    chunks: dataLines.length,
    hasDone: dataLines[dataLines.length - 1] === "[DONE]",
    text: textParts.join(""),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("real: concurrent non-streaming requests", () => {
  it("3 parallel requests all return valid, distinct responses", async () => {
    if (skip()) return;

    const numbers = [7, 13, 19];
    const expected = numbers.map((n) => n * n); // 49, 169, 361
    const results = await Promise.all(numbers.map((n) => sendUniqueRequest(n)));

    for (let i = 0; i < numbers.length; i++) {
      const r = results[i];
      expect(r.status).toBe(200);
      expect(r.id).toBeTruthy();
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.usage.prompt_tokens).toBeGreaterThan(0);
      expect(r.usage.completion_tokens).toBeGreaterThan(0);

      // Check answer contains the expected number (validates no cross-contamination)
      // LLM may include extra text, so just check the number appears
      expect(r.content).toContain(String(expected[i]));
    }

    // All response IDs must be distinct
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(numbers.length);
  }, TIMEOUT * 3);
});

describe("real: concurrent streaming requests", () => {
  it("3 parallel streaming requests all complete without corruption", async () => {
    if (skip()) return;

    const numbers = [5, 11, 23];
    const expected = numbers.map((n) => n + n); // 10, 22, 46
    const results = await Promise.all(numbers.map((n) => sendStreamingRequest(n)));

    for (let i = 0; i < numbers.length; i++) {
      const r = results[i];
      expect(r.status).toBe(200);
      expect(r.hasDone).toBe(true);
      expect(r.chunks).toBeGreaterThanOrEqual(2);
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).toContain(String(expected[i]));
    }
  }, TIMEOUT * 3);
});

describe("real: concurrent usage tracking", () => {
  it("usage counts match actual request count under concurrency", async () => {
    if (skip()) return;

    await resetAllUsage();

    const concurrency = 3;
    const requests = Array.from({ length: concurrency }, (_, i) => sendUniqueRequest(i + 100));
    const results = await Promise.all(requests);

    for (const r of results) {
      expect(r.status).toBe(200);
    }

    const accounts = await getActiveAccounts();
    const totalRequests = accounts.reduce((sum, a) => sum + a.usage.request_count, 0);
    expect(totalRequests).toBe(concurrency);
  }, TIMEOUT * 3);
});

describe("real: mixed streaming and non-streaming concurrent", () => {
  it("streaming and non-streaming requests in parallel both succeed", async () => {
    if (skip()) return;

    const [nonStream, stream] = await Promise.all([
      sendUniqueRequest(42),
      sendStreamingRequest(42),
    ]);

    expect(nonStream.status).toBe(200);
    expect(nonStream.content).toContain("1764"); // 42*42

    expect(stream.status).toBe(200);
    expect(stream.hasDone).toBe(true);
    expect(stream.text).toContain("84"); // 42+42
  }, TIMEOUT * 2);
});
