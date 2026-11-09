/**
 * Tests for /v1/responses public-field passthrough:
 * store / truncation / safety_identifier / metadata / service_tier.
 *
 * Contract reference: the public Responses API documents these as request
 * fields, and OpenAI-compatible SDKs send them verbatim. The ChatGPT Codex
 * backend only accepts store:false and none of the others, so the route keeps
 * them on the internal request and codex-api.ts drops them at that boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { HandleProxyRequestOptions } from "@src/routes/shared/proxy-handler-types.js";

// ── Mocks (before imports) ──────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.3-codex",
    default_reasoning_effort: null as string | null,
    default_service_tier: null as string | null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-responses-fields"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-fields-config"),
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

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

let capturedProxyReq: HandleProxyRequestOptions["req"] | null = null;

vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: HandleProxyRequestOptions) => {
    capturedProxyReq = options.req;
    return options.c.json({ ok: true });
  }),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("/v1/responses — public field passthrough", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedProxyReq = null;
    mockConfig.server.proxy_api_key = null;
    mockConfig.model.default_service_tier = null;
    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
  });

  async function post(body: Record<string, unknown>) {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex", input: "hi", ...body }),
    });
    expect(res.status).toBe(200);
    expect(capturedProxyReq).toBeTruthy();
    return capturedProxyReq!.codexRequest as Record<string, unknown>;
  }

  it("defaults store to false when omitted or non-boolean", async () => {
    expect((await post({})).store).toBe(false);
    expect((await post({ store: "true" })).store).toBe(false);
    expect((await post({ store: 1 })).store).toBe(false);
    expect((await post({ store: null })).store).toBe(false);
  });

  it("forwards store:true from the client", async () => {
    expect((await post({ store: true })).store).toBe(true);
    expect((await post({ store: false })).store).toBe(false);
  });

  it("forwards truncation only for the documented enum values", async () => {
    expect((await post({ truncation: "auto" })).truncation).toBe("auto");
    expect((await post({ truncation: "disabled" })).truncation).toBe("disabled");

    for (const bad of ["none", "AUTO", 1, true, null, {}]) {
      expect(await post({ truncation: bad })).not.toHaveProperty("truncation");
    }
    expect(await post({})).not.toHaveProperty("truncation");
  });

  it("forwards safety_identifier and ignores empty / non-string values", async () => {
    expect((await post({ safety_identifier: "user-123" })).safety_identifier)
      .toBe("user-123");
    expect((await post({ safety_identifier: "  user-456  " })).safety_identifier)
      .toBe("user-456");

    for (const bad of ["", "   ", 42, null, ["a"], { id: "x" }]) {
      expect(await post({ safety_identifier: bad })).not.toHaveProperty("safety_identifier");
    }
    expect(await post({})).not.toHaveProperty("safety_identifier");
  });

  it("forwards metadata as a flat string map and drops non-string values", async () => {
    const req = await post({
      metadata: { team: "core", trace: "abc", n: 7, nested: { a: 1 }, arr: [1] },
    });
    expect(req.metadata).toEqual({ team: "core", trace: "abc" });
  });

  it("keeps metadata separate from client_metadata", async () => {
    const req = await post({
      metadata: { team: "core" },
      client_metadata: { "x-openai-subagent": "review", "x-custom": "kept" },
    });
    expect(req.metadata).toEqual({ team: "core" });
    expect(req.client_metadata).toEqual({
      "x-openai-subagent": "review",
      "x-custom": "kept",
    });
  });

  it("bounds metadata size (entries, key length, value length)", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]),
    );
    const capped = (await post({ metadata: many })).metadata as Record<string, string>;
    expect(Object.keys(capped)).toHaveLength(16);

    const longKey = "k".repeat(200);
    const longValue = "v".repeat(2000);
    const bounded = (await post({ metadata: { [longKey]: longValue } }))
      .metadata as Record<string, string>;
    const [key, value] = Object.entries(bounded)[0];
    expect(key).toHaveLength(64);
    expect(value).toHaveLength(512);
  });

  it("ignores malformed metadata containers", async () => {
    for (const bad of ["str", 5, null, ["a"], true]) {
      expect(await post({ metadata: bad })).not.toHaveProperty("metadata");
    }
    expect(await post({ metadata: {} })).not.toHaveProperty("metadata");
    expect(await post({})).not.toHaveProperty("metadata");
  });

  it("forwards service_tier including the official priority tier", async () => {
    for (const tier of ["fast", "flex", "priority", "auto", "default", "ultrafast"]) {
      expect((await post({ service_tier: tier })).service_tier).toBe(tier);
    }
    expect(await post({})).not.toHaveProperty("service_tier");
  });

  it("keeps all new fields absent when the client sends none", async () => {
    const req = await post({});
    expect(req.store).toBe(false);
    for (const field of ["truncation", "safety_identifier", "metadata", "service_tier"]) {
      expect(req).not.toHaveProperty(field);
    }
  });
});
