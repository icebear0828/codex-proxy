import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono, type Context } from "hono";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { HandleDirectRequestOptions } from "@src/routes/shared/proxy-handler-types.js";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.3-codex",
    default_reasoning_effort: null,
    default_service_tier: null,
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
  getDataDir: vi.fn(() => "/tmp/test-upstream-auth"),
  getConfigDir: vi.fn(() => "/tmp/test-upstream-auth-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null),
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

const mockHandleDirectRequest = vi.fn(async (options: HandleDirectRequestOptions) => options.c.json({ ok: true }));
const mockHandleProxyRequest = vi.fn(async (options: { c: Context }) => options.c.json({ proxied: true }));
vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: (options: { c: Context }) => mockHandleProxyRequest(options),
  handleDirectRequest: (options: HandleDirectRequestOptions) => mockHandleDirectRequest(options),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

function createSentinelAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: vi.fn(async () => new Response()),
    parseStream: vi.fn(async function* () {}),
  };
}

function expectDirectOptions(expected: {
  adapter: UpstreamAdapter;
  model: string;
  formatTag: string;
}): void {
  expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
  const [options] = mockHandleDirectRequest.mock.calls[0] as [HandleDirectRequestOptions];
  expect(options.upstream).toBe(expected.adapter);
  expect(options.req.model).toBe(expected.model);
  expect(options.req.codexRequest.model).toBe(expected.model);
  expect(options.fmt.tag).toBe(expected.formatTag);
  expect(mockHandleProxyRequest).not.toHaveBeenCalled();
}

describe("upstream direct routing without Codex auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    mockHandleDirectRequest.mockImplementation(async (options: HandleDirectRequestOptions) => options.c.json({ ok: true }));
    loadStaticModels();
  });

  it("allows OpenAI chat direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const adapter = createSentinelAdapter("custom-upstream");
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter })),
      resolve: vi.fn(() => adapter),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "my-custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expectDirectOptions({ adapter, model: "my-custom-model", formatTag: "Chat" });
    expect(mockHandleDirectRequest.mock.calls[0][0].req.codexRequest.tools).toEqual([]);
    pool.destroy();
  });

  it.each([
    {
      name: "chat",
      formatTag: "Chat",
      model: "my-custom-model",
      makeApp: (pool: AccountPool, adapter: UpstreamAdapter) =>
        createChatRoutes(pool, undefined, undefined, {
          resolveMatch: vi.fn(() => ({ kind: "adapter", adapter })),
          resolve: vi.fn(() => adapter),
        } as never),
      path: "/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: {
        model: "my-custom-model",
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      name: "messages",
      formatTag: "Messages",
      model: "claude-opus-4-6",
      makeApp: (pool: AccountPool, adapter: UpstreamAdapter) =>
        createMessagesRoutes(pool, undefined, undefined, {
          resolveMatch: vi.fn(() => ({ kind: "adapter", adapter })),
        } as never),
      path: "/v1/messages",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-opus-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      name: "responses",
      formatTag: "Responses",
      model: "my-custom-model",
      makeApp: (pool: AccountPool, adapter: UpstreamAdapter) =>
        createResponsesRoutes(pool, undefined, undefined, {
          resolveMatch: vi.fn(() => ({ kind: "adapter", adapter })),
        } as never),
      path: "/v1/responses",
      headers: { "Content-Type": "application/json" },
      body: {
        model: "my-custom-model",
        input: [{ role: "user", content: "hello" }],
      },
    },
    {
      name: "gemini",
      formatTag: "Gemini",
      model: "gemini-2.5-pro",
      makeApp: (pool: AccountPool, adapter: UpstreamAdapter) =>
        createGeminiRoutes(pool, undefined, undefined, {
          resolveMatch: vi.fn(() => ({ kind: "adapter", adapter })),
        } as never),
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
  ])("passes $name direct routes to handleDirectRequest with named options", async (testCase) => {
    const pool = new AccountPool();
    const adapter = createSentinelAdapter(`sentinel-${testCase.name}`);
    const app = testCase.makeApp(pool, adapter);

    const res = await app.request(testCase.path, {
      method: "POST",
      headers: testCase.headers,
      body: JSON.stringify(testCase.body),
    });

    expect(res.status).toBe(200);
    expectDirectOptions({
      adapter,
      model: testCase.model,
      formatTag: testCase.formatTag,
    });
    pool.destroy();
  });

  it("allows Anthropic messages direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("keeps Anthropic direct routing free of Codex websocket and hosted search rewrites", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "WebSearch",
            description: "Project-local lookup implementation",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ],
        tool_choice: { type: "tool", name: "WebSearch" },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    const directReq = mockHandleDirectRequest.mock.calls[0][0].req as {
      codexRequest: {
        useWebSocket?: boolean;
        tools?: unknown[];
        tool_choice?: unknown;
      };
    };
    expect(directReq.codexRequest.useWebSocket).toBeUndefined();
    expect(directReq.codexRequest.tools).toEqual([
      {
        type: "function",
        name: "WebSearch",
        description: "Project-local lookup implementation",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
    expect(directReq.codexRequest.tool_choice).toEqual({ type: "function", name: "WebSearch" });
    pool.destroy();
  });

  it("allows Gemini direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createGeminiRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("allows Responses direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createResponsesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "my-custom-model",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("bypasses proxy api key validation for configured direct upstream models", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "api-key", adapter: { tag: "custom-upstream" }, entry: { model: "deepseek-chat" } })),
      hasApiKeyModel: vi.fn(() => true),
      resolve: vi.fn(() => ({ tag: "custom-upstream" })),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("returns 404 for unknown models before auth", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "not-found" })),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "unknown-model-xyz",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(404);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    pool.destroy();
  });

  it("still requires login for codex models without api-key fallback", async () => {
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "codex", adapter: { tag: "codex" } })),
      hasApiKeyModel: vi.fn(() => false),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(401);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    pool.destroy();
  });
});
