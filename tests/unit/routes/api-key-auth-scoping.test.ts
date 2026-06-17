/**
 * Tests that apiKeyAuth middleware is scoped to the correct endpoints only.
 * Regression for: https://github.com/icebear0828/codex-proxy/pull/647
 *
 * Before the fix, `app.use("*", apiKeyAuth(...))` in sub-routes caused the
 * middleware to apply globally when sub-routers were mounted at root, leaking
 * 401s onto routes like /v1/models that should be publicly accessible.
 */

import { describe, it, expect, vi } from "vitest";
import type { AccountPool } from "@src/auth/account-pool.js";

// ── Mocks (before route imports) ────────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: "test-secret-key" },
  tls: { proxy_url: null as string | null },
  model: { default: "gpt-5.3-codex" },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("@src/proxy/cookie-jar.js", () => ({
  CookieJar: vi.fn().mockImplementation(() => ({})),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { createChatRoutes } from "@src/routes/chat.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { loadStaticModels } from "@src/models/model-store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createAccountPool(validates = false): AccountPool {
  return {
    validateProxyApiKey: vi.fn(() => validates),
  } as unknown as AccountPool;
}

async function noKeyPost(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function noKeyGet(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
) {
  return app.request(path, { method: "GET" });
}

// ── Protected routes: must return 401 without key ────────────────────────────

describe("chat routes — apiKeyAuth scoped to POST /v1/chat/completions", () => {
  it("returns 401 on POST /v1/chat/completions without key", async () => {
    const app = createChatRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1/chat/completions");
    expect(res.status).toBe(401);
  });
});

describe("messages routes — apiKeyAuth scoped to POST /v1/messages", () => {
  it("returns 401 on POST /v1/messages without key", async () => {
    const app = createMessagesRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1/messages");
    expect(res.status).toBe(401);
  });

  it("returns 401 on POST /v1/messages/count_tokens without key", async () => {
    const app = createMessagesRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1/messages/count_tokens");
    expect(res.status).toBe(401);
  });
});

describe("gemini routes — apiKeyAuth scoped to POST /v1beta/models/:modelAction", () => {
  it("returns 401 on POST /v1beta/models/gpt-5.5:generateContent without key", async () => {
    const app = createGeminiRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1beta/models/gpt-5.5:generateContent");
    expect(res.status).toBe(401);
  });
});

describe("responses routes — apiKeyAuth scoped to response endpoints", () => {
  it("returns 401 on POST /v1/responses without key", async () => {
    const app = createResponsesRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1/responses");
    expect(res.status).toBe(401);
  });

  it("returns 401 on POST /v1/responses/compact without key", async () => {
    const app = createResponsesRoutes(createAccountPool(false));
    const res = await noKeyPost(app, "/v1/responses/compact");
    expect(res.status).toBe(401);
  });
});

// ── Public routes: must NOT return 401 even with proxy_api_key set ───────────

describe("model routes — GET /v1/models is publicly accessible (no auth required)", () => {
  it("returns 200 on GET /v1/models without Authorization header", async () => {
    loadStaticModels();
    const app = createModelRoutes();
    const res = await noKeyGet(app, "/v1/models");
    // Must NOT be 401 — model listing should be public
    expect(res.status).toBe(200);
  });
});
