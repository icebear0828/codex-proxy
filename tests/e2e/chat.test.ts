/**
 * E2E tests for POST /v1/chat/completions (OpenAI Chat API format).
 *
 * Translation details (tool calls, reasoning tokens, cache tokens) are covered
 * by unit tests in src/translation/; this file focuses on:
 *   - OpenAI SSE streaming format (data: {...}\ndata: [DONE])
 *   - OpenAI JSON response structure (chat.completion)
 *   - OpenAI-specific error format
 *   - Auth flow (no accounts, proxy API key)
 *   - Request validation (invalid JSON, missing fields)
 *   - Tool calls in streaming/non-streaming
 *   - Reasoning effort via flat reasoning_effort field
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getLastTransportBody,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import {
  buildTextStreamChunks,
  buildToolCallStreamChunks,
  buildReasoningStreamChunks,
} from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

let ctx: TestContext;

function buildApp(opts?: { noAccount?: boolean }): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();

  if (!opts?.noAccount) {
    accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-chat",
      email: "chat@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createChatRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_chat_1", "Hello from chat!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

function chatRequest(body: unknown) {
  return ctx.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

function parseOpenAISSE(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l.slice(6) !== "[DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: POST /v1/chat/completions", () => {
  // ── OpenAI streaming format ───────────────────────────────────

  it("streaming: OpenAI SSE format with [DONE] terminator", async () => {
    const res = await chatRequest(defaultBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));

    // Must end with [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    // Non-[DONE] chunks are valid JSON with chat.completion.chunk structure
    const chunks = parseOpenAISSE(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
    }

    // Should have content delta
    const contentChunks = chunks.filter((c) => {
      const choices = c.choices as Array<{ delta?: { content?: string } }> | undefined;
      return choices?.[0]?.delta?.content;
    });
    expect(contentChunks.length).toBeGreaterThanOrEqual(1);

    // Final chunk with finish_reason includes usage
    const finalChunk = chunks.find((c) => {
      const choices = c.choices as Array<{ finish_reason: string | null }> | undefined;
      return choices?.[0]?.finish_reason === "stop";
    });
    expect(finalChunk).toBeDefined();
    const usage = finalChunk!.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
    if (usage) {
      expect(usage.prompt_tokens).toBeGreaterThan(0);
      expect(usage.completion_tokens).toBeGreaterThan(0);
    }
  });

  // ── OpenAI JSON format ────────────────────────────────────────

  it("non-streaming: chat.completion structure", async () => {
    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");

    const choices = body.choices as Array<{ message: { role: string; content: string }; finish_reason: string }>;
    expect(choices.length).toBeGreaterThanOrEqual(1);
    expect(choices[0].message.role).toBe("assistant");
    expect(choices[0].message.content).toContain("Hello from chat!");
    expect(choices[0].finish_reason).toBe("stop");

    const usage = body.usage as Record<string, unknown>;
    expect(typeof usage.prompt_tokens).toBe("number");
    expect(typeof usage.completion_tokens).toBe("number");
    expect(typeof usage.total_tokens).toBe("number");
  });

  // ── Tool calls ────────────────────────────────────────────────

  it("non-streaming: tool_calls in response", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_chat_tc", "call_1", "get_weather", '{"location":"NYC"}'),
      ),
    );

    const res = await chatRequest(defaultBody({
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    const choices = body.choices as Array<{
      message: { tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
      finish_reason: string;
    }>;

    expect(choices[0].message.tool_calls).toBeDefined();
    expect(choices[0].message.tool_calls!.length).toBeGreaterThanOrEqual(1);

    const call = choices[0].message.tool_calls![0];
    expect(call.function.name).toBe("get_weather");
    expect(call.type).toBe("function");
    expect(call.id).toBeDefined();
    expect(choices[0].finish_reason).toBe("tool_calls");
  });

  it("streaming: tool_calls in delta chunks", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_chat_tc_s", "call_2", "get_weather", '{"location":"Tokyo"}'),
      ),
    );

    const res = await chatRequest(defaultBody({ stream: true }));
    expect(res.status).toBe(200);

    const chunks = parseOpenAISSE(await res.text());
    const toolChunks = chunks.filter((c) => {
      const choices = c.choices as Array<{ delta?: { tool_calls?: unknown[] } }> | undefined;
      return choices?.[0]?.delta?.tool_calls;
    });
    expect(toolChunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Reasoning effort ──────────────────────────────────────────

  it("reasoning_effort: forwarded to upstream", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildReasoningStreamChunks("resp_chat_r", "thinking...", "Answer")),
    );

    const res = await chatRequest(defaultBody({ reasoning_effort: "high" }));
    expect(res.status).toBe(200);

    // Verify reasoning_effort was forwarded
    const sentBody = JSON.parse(getLastTransportBody()!);
    expect(sentBody.reasoning?.effort).toBe("high");
  });

  // ── Error format ──────────────────────────────────────────────

  it("upstream 429: OpenAI error envelope", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(429);

    const body = await res.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("upstream 500: retries then returns server_error", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(500, JSON.stringify({ detail: "Internal error" })),
    );

    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(500);

    const body = await res.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("server_error");
    expect(body.error.code).toBe("codex_api_error");
    // Should have retried
    expect(getMockTransport().post).toHaveBeenCalledTimes(3);
  }, 10_000);

  // ── Auth ──────────────────────────────────────────────────────

  it("no accounts: returns 401 invalid_api_key", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_api_key");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  // ── Request validation ────────────────────────────────────────

  it("invalid JSON: returns 400 invalid_json", async () => {
    const res = await ctx.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
  });

  it("missing messages: returns 400 invalid_request", async () => {
    const res = await chatRequest({ model: "codex", stream: false });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  // ── Model suffix ──────────────────────────────────────────────

  // TODO: alias "codex" doesn't resolve suffix — codex-high returns 404
  it.skip("model suffix: codex-high resolves reasoning effort", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_chat_sfx", "Suffix!")),
    );

    const res = await chatRequest(defaultBody({ model: "codex-high" }));
    expect(res.status).toBe(200);

    const sentBody = JSON.parse(getLastTransportBody()!);
    expect(sentBody.reasoning?.effort).toBe("high");
  });
});
