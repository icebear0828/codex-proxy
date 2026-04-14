/**
 * E2E tests for POST /v1/responses — Codex Responses API passthrough.
 *
 * Only mocks the external boundary (transport, config, paths, fs, background tasks).
 * CodexApi, AccountPool, CookieJar, all translation layers, all middleware run for real.
 *
 * Each test builds a fresh Hono app to avoid shared account-lock state.
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
} from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

// ── App imports (after mocks declared in e2e-setup) ──────────────────

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

// ── Per-test app lifecycle ───────────────────────────────────────────

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
      accountId: "acct-responses",
      email: "responses@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createResponsesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_r_1", "Hello from responses!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

// ── Helpers ──────────────────────────────────────────────────────────

function responsesRequest(body: unknown) {
  return ctx.app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    instructions: "You are helpful",
    input: [{ role: "user", content: "Hello" }],
    model: "codex",
    stream: true,
    ...overrides,
  };
}

/** Parse named SSE events (event: xxx\ndata: {...}) into structured objects. */
function parseNamedSSE(text: string): Array<{ event: string; data: unknown }> {
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

describe("E2E: POST /v1/responses", () => {
  it("streaming: SSE passthrough with named events", async () => {
    const res = await responsesRequest(defaultBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    const events = parseNamedSSE(text);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Should have named events, not OpenAI format
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain("response.created");
    expect(eventNames).toContain("response.output_text.delta");
    expect(eventNames).toContain("response.completed");

    // Verify text delta event has delta content
    const textDelta = events.find((e) => e.event === "response.output_text.delta");
    expect(textDelta).toBeDefined();
    const deltaData = textDelta!.data as { delta?: string };
    expect(deltaData.delta).toBe("Hello from responses!");

    // Verify completed event has usage
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeDefined();
    const completedData = completed!.data as { response?: { usage?: { input_tokens: number; output_tokens: number } } };
    expect(completedData.response?.usage?.input_tokens).toBe(10);
    expect(completedData.response?.usage?.output_tokens).toBe(5);
  });

  it("non-streaming: collects into JSON response object", async () => {
    const res = await responsesRequest(defaultBody({ stream: false }));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    // The response should be the Codex response object from the completed event
    expect(body.id).toBe("resp_r_1");
    expect(body.usage).toBeDefined();
    const usage = body.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  it("tool calls passthrough: SSE has function_call events", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_r_fc", "call_1", "get_weather", '{"location":"NYC"}'),
      ),
    );

    const res = await responsesRequest(defaultBody());
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseNamedSSE(text);
    const eventNames = events.map((e) => e.event);

    expect(eventNames).toContain("response.output_item.added");
    expect(eventNames).toContain("response.function_call_arguments.done");

    // Verify function call item
    const fcAdded = events.find((e) => e.event === "response.output_item.added");
    expect(fcAdded).toBeDefined();
    const fcData = fcAdded!.data as { item?: { type?: string; name?: string } };
    expect(fcData.item?.type).toBe("function_call");
    expect(fcData.item?.name).toBe("get_weather");

    // Verify arguments done
    const fcDone = events.find((e) => e.event === "response.function_call_arguments.done");
    expect(fcDone).toBeDefined();
    const doneData = fcDone!.data as { arguments?: string; name?: string };
    expect(doneData.name).toBe("get_weather");
    expect(doneData.arguments).toBe('{"location":"NYC"}');
  });

  it("model suffix parsing: codex-high-fast resolves correctly", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_r_suffix", "Suffix response!")),
    );

    const res = await responsesRequest(defaultBody({ model: "codex-high-fast" }));
    expect(res.status).toBe(200);

    // Verify the transport body has the resolved model ID
    const sentBody = JSON.parse(getLastTransportBody()!);
    expect(sentBody.model).toBe("gpt-5.4");
    // Reasoning effort should be set from suffix
    expect(sentBody.reasoning?.effort).toBe("high");
  });

  it("unauthenticated: returns 401 with invalid_api_key", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      type ErrorResponse = {
        type: string;
        error: { type: string; code: string; message: string };
      };
      const body = await res.json() as ErrorResponse;
      expect(body.error.code).toBe("invalid_api_key");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  it("invalid JSON: returns 400 with invalid_json", async () => {
    const res = await ctx.app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);

    type ErrorResponse = {
      type: string;
      error: { type: string; code: string; message: string };
    };
    const body = await res.json() as ErrorResponse;
    expect(body.error.code).toBe("invalid_json");
  });

  it("missing instructions: succeeds with empty string default", async () => {
    const res = await responsesRequest({
      input: [{ role: "user", content: "Hello" }],
      model: "codex",
      stream: true,
    });
    expect(res.status).toBe(200);

    // Verify instructions defaults to "" in the upstream request
    const raw = getLastTransportBody();
    expect(raw).toBeDefined();
    const sent = JSON.parse(raw!) as Record<string, unknown>;
    expect(sent.instructions).toBe("");
  });

  it("upstream 429: returns 429 with rate_limit_error", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await responsesRequest(defaultBody());
    expect(res.status).toBe(429);

    type ErrorResponse = {
      type: string;
      error: { type: string; code: string; message: string };
    };
    const body = await res.json() as ErrorResponse;
    expect(body.error.type).toBe("rate_limit_error");
  });
});
