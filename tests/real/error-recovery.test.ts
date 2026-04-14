/**
 * Real upstream tests — error recovery.
 *
 * Verifies:
 * 1. Malformed requests → proper error, proxy stays healthy
 * 2. Requests succeed after error (recovery)
 * 3. Proxy doesn't leak state between failed and successful requests
 * 4. Rapid error sequences don't degrade proxy health
 *
 * Note: Invalid model names may still return 200 (upstream handles gracefully).
 * Use actually malformed payloads to trigger real errors.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, API_KEY, TIMEOUT,
  checkProxy, skip, headers,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── Helpers ─────────────────────────────────────────────────────────

async function sendOpenAI(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function sendAnthropic(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: { ...headers(), "x-api-key": API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function sendCodex(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function checkHealth(): Promise<boolean> {
  const res = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(5000) });
  return res.ok;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("real: malformed request then recovery", () => {
  it("OpenAI: missing messages → error, then valid request succeeds", async () => {
    if (skip()) return;

    // Malformed: no messages field
    const err = await sendOpenAI({ model: "codex", stream: false });
    expect(err.status).toBe(400);

    // Valid request immediately after
    const ok = await sendOpenAI({
      model: "codex",
      messages: [{ role: "user", content: "Reply with 'ok'." }],
      stream: false,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.choices).toBeDefined();
  }, TIMEOUT * 2);

  it("Anthropic: missing messages → error, then valid request succeeds", async () => {
    if (skip()) return;

    const err = await sendAnthropic({ model: "codex", max_tokens: 100 });
    expect(err.status).toBe(400);

    const ok = await sendAnthropic({
      model: "codex",
      max_tokens: 100,
      messages: [{ role: "user", content: "Reply with 'ok'." }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBeDefined();
  }, TIMEOUT * 2);

  it("Codex: missing input → error, then valid request succeeds", async () => {
    if (skip()) return;

    const err = await sendCodex({ model: "codex", stream: false });
    // missing input may be 400 or a non-200 upstream error
    expect(err.status).not.toBe(200);

    const ok = await sendCodex({
      model: "codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with 'ok'." }] }],
      stream: false,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("completed");
  }, TIMEOUT * 2);
});

describe("real: auth error then recovery", () => {
  it("bad API key → 401, then valid key → 200", async () => {
    if (skip()) return;

    // Request with wrong key
    const badRes = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-key-12345",
      },
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(badRes.status).toBe(401);
    await badRes.text();

    // Good request with valid key
    const ok = await sendOpenAI({
      model: "codex",
      messages: [{ role: "user", content: "Reply with 'ok'." }],
      stream: false,
    });
    expect(ok.status).toBe(200);
  }, TIMEOUT * 2);

  it("no auth header → 401", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "test" }],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    expect(res.status).toBe(401);
    await res.text();
  }, TIMEOUT);
});

describe("real: rapid error sequence doesn't degrade proxy", () => {
  it("5 consecutive bad requests, then valid request succeeds", async () => {
    if (skip()) return;

    // Fire off 5 malformed requests
    for (let i = 0; i < 5; i++) {
      const { status } = await sendOpenAI({ model: "codex", stream: false });
      expect(status).toBe(400);
    }

    // Proxy should still be healthy
    expect(await checkHealth()).toBe(true);

    // Valid request works
    const ok = await sendOpenAI({
      model: "codex",
      messages: [{ role: "user", content: "Reply with 'recovered'." }],
      stream: false,
    });
    expect(ok.status).toBe(200);
  }, TIMEOUT * 3);
});

describe("real: streaming error handling", () => {
  it("malformed streaming request returns error, not hanging stream", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        stream: true,
        // Missing messages
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // Should get an error response (not hang)
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it("streaming error followed by valid streaming request works", async () => {
    if (skip()) return;

    // Error (no messages)
    const errRes = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "codex", stream: true }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    await errRes.text();

    // Valid streaming
    const okRes = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "Reply with 'hello'." }],
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(okRes.status).toBe(200);
    const text = await okRes.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  }, TIMEOUT * 2);
});

describe("real: concurrent errors don't poison the pool", () => {
  it("parallel malformed + valid requests both resolve correctly", async () => {
    if (skip()) return;

    const [err, ok] = await Promise.all([
      sendOpenAI({ model: "codex", stream: false }), // malformed: no messages
      sendOpenAI({
        model: "codex",
        messages: [{ role: "user", content: "Reply with 'ok'." }],
        stream: false,
      }),
    ]);

    expect(err.status).toBe(400);
    expect(ok.status).toBe(200);
    expect(ok.body.choices).toBeDefined();
  }, TIMEOUT * 2);
});
