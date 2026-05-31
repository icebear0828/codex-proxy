/**
 * E2E tests for POST /v1/messages (Anthropic Messages API format).
 *
 * Translation details (tool calls, thinking blocks, cache tokens) are covered
 * by unit tests in src/translation/; this file focuses on:
 *   - Anthropic SSE event structure (message_start, content_block_*, message_delta)
 *   - Anthropic JSON response structure
 *   - Anthropic-specific error format
 *   - Auth flow
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  getLastTransportBody,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
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
      accountId: "acct-e2e-msg",
      email: "msg@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_msg_1", "Hello!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

function messagesRequest(body: unknown) {
  return ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function countTokensRequest(body: unknown) {
  return ctx.app.request("/v1/messages/count_tokens?beta=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

function parseAnthropicSSE(text: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  const lines = text.split("\n");
  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) currentEvent = line.slice(7);
    else if (line.startsWith("data: ")) {
      try { results.push({ event: currentEvent, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
      currentEvent = "";
    }
  }
  return results;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: POST /v1/messages", () => {
  it("count_tokens: returns local Anthropic-compatible token estimate without upstream call", async () => {
    const res = await countTokensRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello from Claude Code" }],
      tools: [{
        name: "Read",
        description: "Read a file from the local workspace",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      }],
      betas: ["token-efficient-tools-2025-02-19"],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { input_tokens?: unknown };
    expect(typeof body.input_tokens).toBe("number");
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.input_tokens).toBeLessThan(500);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("count_tokens: works without an authenticated Codex account", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "count only" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { input_tokens?: unknown };
      expect(typeof body.input_tokens).toBe("number");
      expect(body.input_tokens).toBeGreaterThan(0);
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  it("count_tokens: invalid requests return Anthropic error shape", async () => {
    const res = await countTokensRequest({
      model: "gpt-5.5",
      messages: [],
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // ── Anthropic SSE format ───────────────────────────────────────

  it("streaming: full Anthropic SSE event sequence", async () => {
    const res = await messagesRequest(defaultBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const events = parseAnthropicSSE(await res.text());
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    // message_start has correct structure
    const msgStart = events.find((e) => e.event === "message_start")!.data as Record<string, unknown>;
    const message = msgStart.message as Record<string, unknown>;
    expect(message.role).toBe("assistant");
    expect(message.type).toBe("message");

    // message_delta has stop_reason
    const msgDelta = events.find((e) => e.event === "message_delta")!.data as Record<string, unknown>;
    expect((msgDelta.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  // ── Anthropic JSON format ──────────────────────────────────────

  it("non-streaming: Anthropic message structure", async () => {
    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");

    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Hello!");

    const usage = body.usage as Record<string, unknown>;
    expect(typeof usage.input_tokens).toBe("number");
    expect(typeof usage.output_tokens).toBe("number");
  });

  it("uses Claude Code session id as prompt_cache_key", async () => {
    const res = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claude-code-session-id": "claude-code-session-123",
      },
      body: JSON.stringify(defaultBody({
        messages: [{ role: "user", content: "Start a project task" }],
      })),
    });
    expect(res.status).toBe(200);

    const transportBody = getLastTransportBody();
    if (!transportBody) {
      throw new Error("Expected upstream transport body to be captured");
    }

    const upstreamRequest = JSON.parse(transportBody) as { prompt_cache_key?: unknown };
    expect(upstreamRequest.prompt_cache_key).toBe("claude-code-session-123");
  });

  // ── Anthropic error format ─────────────────────────────────────

  it("upstream 429: Anthropic error envelope", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(429);

    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("upstream 500: retries then returns api_error", async () => {
    // Count attempts at the underlying transport (covers both WS and HTTP
    // paths; messages.ts forces useWebSocket=true, so withRetry retries the
    // WS attempt 3x rather than falling back to HTTP).
    const post = vi.fn(async () =>
      makeErrorTransportResponse(500, JSON.stringify({ detail: "Internal error" })),
    );
    setTransportPost(post);

    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(500);

    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(post).toHaveBeenCalledTimes(3);
  }, 10_000);

  // ── Auth ───────────────────────────────────────────────────────

  it("no accounts: returns 401 authentication_error", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });
});
