/**
 * Integration tests for plan-based model routing through the proxy layer.
 *
 * Verifies that:
 * 1. Account pool correctly filters by model plan types when proxy handler acquires an account
 * 2. Plan map updates unblock previously rejected requests
 * 3. POST /admin/refresh-models triggers immediate model refresh
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// ── Mocks (before imports) ──────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: { default: "gpt-5.2-codex" },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-plan-routing"),
  getConfigDir: vi.fn(() => "/tmp/test-plan-routing-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) =>
        cb(null),
    ),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

const mockCreateResponse = vi.fn();

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    createResponse: mockCreateResponse,
  })),
  CodexApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(body);
      this.name = "CodexApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("../../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "../../auth/account-pool.js";
import {
  loadStaticModels,
  applyBackendModelsForPlan,
} from "../../models/model-store.js";
import { extractUserProfile } from "../../auth/jwt-utils.js";
import {
  handleProxyRequest,
  type FormatAdapter,
  type ProxyRequest,
} from "../shared/proxy-handler.js";
import type { StatusCode } from "hono/utils/http-status";
import { createModelRoutes } from "../models.js";
import { triggerImmediateRefresh } from "../../models/model-fetcher.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeModel(slug: string) {
  return { slug, id: slug, name: slug };
}

function createTestFormat(): FormatAdapter {
  return {
    tag: "Test",
    noAccountStatus: 503 as StatusCode,
    formatNoAccount: () => ({
      error: {
        message: "No account available for this model",
        type: "server_error",
      },
    }),
    format429: (msg: string) => ({
      error: { message: msg, type: "rate_limit_error" },
    }),
    formatError: (status: number, msg: string) => ({
      error: { status, message: msg },
    }),
    streamTranslator: async function* () {
      yield "data: {}\n\n";
    },
    collectTranslator: async () => ({
      response: { id: "resp-test", object: "chat.completion", choices: [] },
      usage: { input_tokens: 10, output_tokens: 20 },
      responseId: "resp-test",
    }),
  };
}

function makeProxyRequest(model: string): ProxyRequest {
  return {
    codexRequest: { model } as ProxyRequest["codexRequest"],
    model,
    isStreaming: false,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("plan routing through proxy handler", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.auth.jwt_token = undefined;
    mockConfig.server.proxy_api_key = null;
    delete process.env.CODEX_JWT_TOKEN;

    loadStaticModels();

    vi.mocked(extractUserProfile).mockImplementation((token: string) => {
      if (token.startsWith("free-"))
        return { email: "free@test.com", chatgpt_plan_type: "free" };
      if (token.startsWith("team-"))
        return { email: "team@test.com", chatgpt_plan_type: "team" };
      return null;
    });

    pool = new AccountPool();
    mockCreateResponse.mockResolvedValue(
      new Response(JSON.stringify({ ok: true })),
    );
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("free-only pool + team-only model → 503", async () => {
    pool.addAccount("free-token-1");
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("No account");
  });

  it("free-only pool + model in both plans → 200", async () => {
    pool.addAccount("free-token-1");
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("plan map update → previously blocked request now succeeds", async () => {
    pool.addAccount("free-token-1");
    applyBackendModelsForPlan("team", [makeModel("gpt-5.4")]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    // Blocked — free can't use team-only model
    const res1 = await app.request("/test", { method: "POST" });
    expect(res1.status).toBe(503);

    // Backend refresh: free now has gpt-5.4
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);

    // Same request now succeeds
    const res2 = await app.request("/test", { method: "POST" });
    expect(res2.status).toBe(200);
  });

  it("team-only pool + team model → 200", async () => {
    pool.addAccount("team-token-1");
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("mixed pool prefers plan-matched account", async () => {
    pool.addAccount("free-token-1");
    pool.addAccount("team-token-1");
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    // Team account is used (only plan supporting gpt-5.4)
    expect(mockCreateResponse).toHaveBeenCalledOnce();
  });
});

describe("POST /admin/refresh-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
  });

  it("triggers model refresh and returns 200", async () => {
    const app = createModelRoutes();
    const res = await app.request("/admin/refresh-models", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Model refresh triggered");
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "test-secret";
    const app = createModelRoutes();

    // No auth → 401
    const res1 = await app.request("/admin/refresh-models", {
      method: "POST",
    });
    expect(res1.status).toBe(401);
    expect(triggerImmediateRefresh).not.toHaveBeenCalled();

    // Wrong auth → 401
    const res2 = await app.request("/admin/refresh-models", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res2.status).toBe(401);

    // Correct auth → 200
    const res3 = await app.request("/admin/refresh-models", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res3.status).toBe(200);
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });
});
