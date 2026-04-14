/**
 * E2E tests for Gemini API endpoints.
 *
 * Translation details (tool calls, thinking, cache tokens) are covered
 * by unit tests in src/translation/; this file focuses on:
 *   - Gemini NDJSON streaming format
 *   - Gemini JSON response structure
 *   - Gemini-specific error format (code + status)
 *   - Model listing in Gemini format
 *   - Auth flow
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
import { createGeminiRoutes } from "@src/routes/gemini.js";
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
      accountId: "acct-gemini",
      email: "gemini@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createGeminiRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_gem_1", "Hello from Gemini!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    ...overrides,
  };
}

type GeminiChunk = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function parseNDJSON(text: string): GeminiChunk[] {
  const results: GeminiChunk[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { results.push(JSON.parse(line.slice(6)) as GeminiChunk); } catch { /* skip */ }
    }
  }
  return results;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: Gemini endpoints", () => {
  // ── Streaming format ───────────────────────────────────────────

  it("streamGenerateContent: NDJSON with candidates and usageMetadata", async () => {
    const res = await ctx.app.request("/v1beta/models/codex:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultBody()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const chunks = parseNDJSON(await res.text());
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Text content
    const textChunks = chunks.filter(
      (c) => c.candidates?.[0]?.content?.parts?.[0]?.text,
    );
    expect(textChunks[0].candidates![0].content!.parts![0].text).toContain("Hello from Gemini!");

    // Final chunk has finishReason + usage
    const final = chunks[chunks.length - 1];
    expect(final.candidates![0].finishReason).toBe("STOP");
    expect(final.usageMetadata).toBeDefined();
    expect(final.usageMetadata!.totalTokenCount).toBe(15);
  });

  // ── Non-streaming format ───────────────────────────────────────

  it("generateContent: JSON with Gemini structure", async () => {
    const res = await ctx.app.request("/v1beta/models/codex:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultBody()),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as GeminiChunk;
    expect(body.candidates![0].content!.parts![0].text).toContain("Hello from Gemini!");
    expect(body.candidates![0].content!.role).toBe("model");
    expect(body.candidates![0].finishReason).toBe("STOP");
    expect(body.usageMetadata!.totalTokenCount).toBe(15);
  });

  // ── Model listing ──────────────────────────────────────────────

  it("GET /v1beta/models: Gemini model list format", async () => {
    const res = await ctx.app.request("/v1beta/models");
    expect(res.status).toBe(200);

    type GeminiModelList = {
      models: Array<{
        name: string;
        displayName: string;
        supportedGenerationMethods: string[];
      }>;
    };

    const body = await res.json() as GeminiModelList;
    expect(body.models.length).toBeGreaterThanOrEqual(1);

    for (const model of body.models) {
      expect(model.name).toMatch(/^models\//);
      expect(model.supportedGenerationMethods).toContain("generateContent");
    }
  });

  // ── Error format ───────────────────────────────────────────────

  it("upstream 429: Gemini error with RESOURCE_EXHAUSTED status", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await ctx.app.request("/v1beta/models/codex:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultBody()),
    });
    expect(res.status).toBe(429);

    const body = await res.json() as { error: { code: number; status: string } };
    expect(body.error.code).toBe(429);
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
  });

  // ── Auth ───────────────────────────────────────────────────────

  it("no accounts: returns 401 UNAUTHENTICATED", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1beta/models/codex:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { error: { code: number; status: string } };
      expect(body.error.status).toBe("UNAUTHENTICATED");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });
});
