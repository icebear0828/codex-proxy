/**
 * Stress test: concurrent request handling.
 * Run with: npm run test:stress
 *
 * Uses the E2E setup to run a real app with mock transport.
 *
 * Note: The proxy handler acquires an account lock per request and holds it
 * until the response is fully streamed/collected. With N accounts, at most
 * N requests can be in-flight simultaneously. Tests must account for this.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
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
import { getConfig } from "@src/config.js";
import { createMockConfig } from "@helpers/config.js";

// ── Per-test app lifecycle ───────────────────────────────────────────

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

function buildApp(accountCount: number): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  for (let i = 0; i < accountCount; i++) {
    accountPool.addAccount(createValidJwt({
      accountId: `acct-stress-${i}`,
      email: `stress${i}@test.com`,
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

// ── Helpers ──────────────────────────────────────────────────────────

function chatRequest(app: Hono, body: unknown) {
  return app.request("/v1/chat/completions", {
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

// ── Tests ────────────────────────────────────────────────────────────

describe("concurrent requests", () => {
  let ctx: TestContext;

  beforeEach(() => {
    resetTransportState();
    let counter = 0;
    setTransportPost(async () => {
      counter++;
      // Small delay to simulate real latency
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeTransportResponse(
        buildTextStreamChunks(`resp_${counter}`, `Response ${counter}`),
      );
    });
    vi.mocked(getMockTransport().post).mockClear();
  });

  afterEach(() => {
    if (ctx) {
      ctx.cookieJar.destroy();
      ctx.proxyPool.destroy();
      ctx.accountPool.destroy();
    }
  });

  it("10 concurrent non-streaming requests complete", async () => {
    // Use 10 accounts so each concurrent request can acquire its own lock
    ctx = buildApp(10);
    const requests = Array.from({ length: 10 }, () =>
      chatRequest(ctx.app, defaultBody()),
    );
    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
      const json = await res.json() as { object: string };
      expect(json.object).toBe("chat.completion");
    }
  });

  it("10 concurrent streaming requests complete", async () => {
    // Use 10 accounts so each concurrent request can acquire its own lock
    ctx = buildApp(10);
    const requests = Array.from({ length: 10 }, () =>
      chatRequest(ctx.app, defaultBody({ stream: true })),
    );
    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("[DONE]");
    }
  });

  it("concurrent requests use different accounts", async () => {
    // Force max_concurrent=1 so each concurrent request must use a different account
    vi.mocked(getConfig).mockReturnValue(createMockConfig({
      auth: { max_concurrent_per_account: 1 },
    }));
    ctx = buildApp(3);
    // Fire 3 concurrent requests — exactly matches account count
    const requests = Array.from({ length: 3 }, () =>
      chatRequest(ctx.app, defaultBody()),
    );
    const responses = await Promise.all(requests);

    // All should succeed
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Check that all accounts got used (max_concurrent=1 forces distribution)
    const accounts = ctx.accountPool.getAccounts();
    const usedAccounts = accounts.filter((a) => a.usage.request_count > 0);
    expect(usedAccounts.length).toBe(3);
    const totalRequests = accounts.reduce(
      (sum, a) => sum + a.usage.request_count,
      0,
    );
    expect(totalRequests).toBe(3);
  });

  it("concurrent + one rate limited", async () => {
    // Force max_concurrent=1 so each request uses a different account
    vi.mocked(getConfig).mockReturnValue(createMockConfig({
      auth: { max_concurrent_per_account: 1 },
    }));
    ctx = buildApp(3);

    let callIndex = 0;
    setTransportPost(async () => {
      callIndex++;
      const idx = callIndex;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (idx === 1) {
        // First request gets rate limited
        return makeErrorTransportResponse(
          429,
          JSON.stringify({
            detail: { clears_in: 60, message: "Rate limited" },
          }),
        );
      }
      return makeTransportResponse(
        buildTextStreamChunks(`resp_${idx}`, `Response ${idx}`),
      );
    });

    // Fire 3 concurrent requests (matches account count, max_concurrent=1 forces spread)
    const requests = Array.from({ length: 3 }, () =>
      chatRequest(ctx.app, defaultBody()),
    );
    const responses = await Promise.allSettled(requests);

    // Count successes and 429s
    let ok = 0;
    let rateLimitErr = 0;
    for (const result of responses) {
      if (result.status === "fulfilled") {
        if (result.value.status === 200) ok++;
        else if (result.value.status === 429) rateLimitErr++;
      }
    }

    // 2 succeed directly; the 429'd request cannot retry because all 3 slots
    // are occupied (max_concurrent=1 × 3 accounts), so it returns 429 to client
    expect(ok).toBe(2);
    expect(rateLimitErr).toBe(1);

    // The rate-limited account should be marked
    const accounts = ctx.accountPool.getAccounts();
    const rateLimited = accounts.filter((a) => a.status === "rate_limited");
    expect(rateLimited.length).toBe(1);
  });

  it("high throughput: 50 sequential requests", async () => {
    ctx = buildApp(2);

    for (let i = 0; i < 50; i++) {
      const res = await chatRequest(ctx.app, defaultBody());
      expect(res.status).toBe(200);
    }

    const accounts = ctx.accountPool.getAccounts();
    const totalRequests = accounts.reduce(
      (sum, a) => sum + a.usage.request_count,
      0,
    );
    expect(totalRequests).toBe(50);
  });
});
