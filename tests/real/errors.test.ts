/**
 * Real upstream tests — error format validation.
 *
 * Verifies that error responses from the proxy conform to each API format's
 * error specification (OpenAI, Anthropic, Gemini, Codex Responses).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, anthropicHeaders,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── OpenAI error format ──────────────────────────────────────────────

describe("real: OpenAI error format", () => {
  it("invalid model returns structured error", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "nonexistent-model-xyz-999",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // Should not be 500 — should be a clean 4xx or mapped error
    expect(res.status).not.toBe(500);

    const body = await res.json() as Record<string, unknown>;
    const error = body.error as { message: string; type: string; code: string } | undefined;

    // If proxy returns an error (not proxied upstream), verify format
    if (error) {
      expect(typeof error.message).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
      expect(typeof error.type).toBe("string");
    }
  }, TIMEOUT);

  it("missing messages field returns 400", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        // missing: messages
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as { message: string; type: string };
    expect(error).toBeDefined();
    expect(typeof error.message).toBe("string");
  }, TIMEOUT);

  it("invalid JSON returns 400", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: "{ invalid json",
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(400);
  }, TIMEOUT);
});

// ── Anthropic error format ───────────────────────────────────────────

describe("real: Anthropic error format", () => {
  it("missing messages returns structured error", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 100,
        // missing: messages
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("error");

    const error = body.error as { type: string; message: string };
    expect(error).toBeDefined();
    expect(typeof error.type).toBe("string");
    expect(typeof error.message).toBe("string");
  }, TIMEOUT);

  it("invalid model returns structured Anthropic error", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "nonexistent-model-xyz-999",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).not.toBe(500);
    const body = await res.json() as Record<string, unknown>;

    if (body.type === "error") {
      const error = body.error as { type: string; message: string };
      expect(typeof error.type).toBe("string");
      expect(typeof error.message).toBe("string");
    }
  }, TIMEOUT);
});

// ── Gemini error format ──────────────────────────────────────────────

describe("real: Gemini error format", () => {
  it("invalid model returns structured Gemini error", async () => {
    if (skip()) return;

    const res = await fetch(
      `${PROXY_URL}/v1beta/models/nonexistent-model-xyz:generateContent`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "test" }] }],
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );

    expect(res.status).not.toBe(500);
    const body = await res.json() as Record<string, unknown>;

    if (body.error) {
      const error = body.error as { code: number; message: string; status: string };
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
      expect(typeof error.status).toBe("string");
    }
  }, TIMEOUT);

  it("empty contents returns error", async () => {
    if (skip()) return;

    const res = await fetch(
      `${PROXY_URL}/v1beta/models/codex:generateContent`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          contents: [],
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );

    // Should be 400 or upstream error, not 500
    expect(res.status).not.toBe(500);
  }, TIMEOUT);
});

// ── Codex Responses error format ─────────────────────────────────────

describe("real: Responses error format", () => {
  it("missing input returns error (not 500)", async () => {
    if (skip()) return;

    // Note: responses.ts defaults missing input to [] (empty array), which is
    // forwarded to upstream. This is intentional — the upstream decides whether
    // an empty conversation is valid. The test only verifies no 500 crash.
    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // Proxy may validate locally (400), forward to upstream (502), or upstream may reject auth (401)
    expect(res.status).not.toBe(500);
    const body = await res.json() as Record<string, unknown>;

    if (body.type === "error") {
      const error = body.error as { type: string; message: string };
      expect(typeof error.message).toBe("string");
    }
  }, TIMEOUT);

  it("invalid model returns non-500 error", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "nonexistent-model-xyz-999",
        input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.status).not.toBe(500);
    const body = await res.json() as Record<string, unknown>;

    if (body.type === "error") {
      const error = body.error as { type: string; message: string };
      expect(typeof error.message).toBe("string");
    }
  }, 60_000);
});

// ── Auth errors ──────────────────────────────────────────────────────

describe("real: auth errors", () => {
  it("missing auth returns 401 in OpenAI format", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // If proxy has auth enabled, should return 401
    // If no auth, this may succeed — both are valid
    if (res.status === 401) {
      const body = await res.json() as Record<string, unknown>;
      const error = body.error as { message: string; type: string; code: string };
      expect(error).toBeDefined();
      expect(error.code).toBe("invalid_api_key");
    }
  }, TIMEOUT);

  it("wrong api key returns 401", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
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

    // If proxy has auth enabled, should return 401
    if (res.status === 401) {
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBeDefined();
    }
  }, TIMEOUT);
});
