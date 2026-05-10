import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { CodexResponsesRequest } from "@src/proxy/codex-api.js";

const mockState = vi.hoisted(() => ({
  responseIdCount: 0,
}));

// ── Mocks ───────────────────────────────────────────────
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
    request_interval_ms: 0,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-compact"),
  getConfigDir: vi.fn(() => "/tmp/test-compact-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("@src/models/model-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/models/model-store.js")>();
  return {
    ...actual,
    loadStaticModels: vi.fn(),
    isRecognizedModelName: vi.fn(() => true),
    getModelCatalog: vi.fn(() => []),
  };
});
vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
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

// Capture upstream requests
let capturedCodexRequest: CodexResponsesRequest | null = null;

vi.mock("@src/proxy/codex-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/proxy/codex-api.js")>();
  return {
    ...actual,
    CodexApi: vi.fn().mockImplementation(() => ({
      createResponse: vi.fn(async (req: CodexResponsesRequest) => {
        capturedCodexRequest = structuredClone(req);
        return {
          status: 200,
          headers: new Headers({ "x-codex-turn-state": "turn-123" }),
        };
      }),
    })),
  };
});

vi.mock("@src/translation/codex-to-openai.js", () => ({
  streamCodexToOpenAI: vi.fn(),
  collectCodexResponse: vi.fn(async (_api, _resp, _model, _wantReasoning, _tuple, usageHint, onMetadata) => {
    mockState.responseIdCount++;
    const id = `resp-${mockState.responseIdCount}`;
    return {
      response: { id, choices: [{ message: { role: "assistant", content: "ok" } }] },
      usage: { input_tokens: 10, output_tokens: 5 },
      responseId: id,
    };
  }),
}));

vi.mock("@src/translation/codex-to-gemini.js", () => ({
  streamCodexToGemini: vi.fn(),
  collectCodexToGeminiResponse: vi.fn(async (_api, _resp, _model, _tuple) => {
    mockState.responseIdCount++;
    const id = `resp-${mockState.responseIdCount}`;
    return {
      response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
      usage: { input_tokens: 10, output_tokens: 5 },
      responseId: id,
    };
  }),
}));


// No mock for session-affinity.js, we test the real implementation.

// ── Imports ─────────────────────────────────────────────────────────
import { AccountPool } from "@src/auth/account-pool.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { getSessionAffinityMap } from "@src/auth/session-affinity.js";

// ── Tests ───────────────────────────────────────────────────────────

function getCapturedCodexRequest(): CodexResponsesRequest {
  if (!capturedCodexRequest) {
    throw new Error("Expected Codex request to be captured");
  }
  return capturedCodexRequest;
}

describe("Implicit Resume from Derived Key", () => {
  let pool: AccountPool;
  let chatApp: Hono;
  let geminiApp: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCodexRequest = null;
    mockState.responseIdCount = 0;
    delete process.env.CODEX_JWT_TOKEN; // Prevent AccountPool from loading multiple accounts
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    chatApp = createChatRoutes(pool);
    geminiApp = createGeminiRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
    getSessionAffinityMap().dispose();
  });

  it("Test 1 & 2: Chat endpoint uses derived key and triggers implicit resume on multi-turn", async () => {
    // Turn 1
    const t1Input = [{ role: "user", content: "First message" }];
    const req1 = await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: t1Input,
      }),
    });
    
    let captured = getCapturedCodexRequest();
    expect(captured.previous_response_id).toBeUndefined(); // First turn, no implicit resume
    const derivedKeyT1 = captured.prompt_cache_key;
    expect(derivedKeyT1).toBeDefined();
    
    // Turn 2
    // Client sends the history
    const t2Input = [
      ...t1Input,
      { role: "assistant", content: "ok" },
      { role: "user", content: "Hello again" },
    ];
    
    const req2 = await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: t2Input,
      }),
    });
    
    // T2 should have triggered implicit resume
    captured = getCapturedCodexRequest();
    expect(captured.previous_response_id).toBe("resp-1");
    expect(captured.input).toEqual([{ role: "user", content: "Hello again" }]);
  });

  it("Test 1 & 2b: Chat endpoint uses client session via 'user' field if provided", async () => {
    const explicitUserId = "client-provided-session-uuid";
    const req1 = await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hi" }],
        user: explicitUserId,
      }),
    });
    expect(req1.status).toBe(200);
    expect(getCapturedCodexRequest().prompt_cache_key).toBe(explicitUserId);
    
    // The chainConversationId used for affinity should be the client ID
    const affinityMap = getSessionAffinityMap();
    expect(affinityMap.lookupConversationId("resp-1")).toBe(explicitUserId);
  });

  it("Test 3: Gemini route extracts session ID from headers", async () => {
    const req1 = await geminiApp.request("/v1beta/models/gemini-1.5-pro:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "gemini-test-session-id",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    });
    expect(req1.status).toBe(200);
    expect(getCapturedCodexRequest().prompt_cache_key).toBe("gemini-test-session-id");

    const affinityMap = getSessionAffinityMap();
    expect(affinityMap.lookupConversationId("resp-1")).toBe("gemini-test-session-id");
  });

  it("Test 5: variantHash 隔离 — 同 conv 不同 system → implicit resume 不复用主对话的 prev id", async () => {
    const sessionId = "shared-session";

    // 主对话第 1 轮：system A，留下 resp-1
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are MAIN." },
          { role: "user", content: "hi" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBeUndefined();

    // 子代理第 1 轮：同 sessionId，但 system 不同（→ variantHash 不同）。
    // 即便走的是同一个 conv，也不应该错误地继承主对话的 resp-1。
    capturedCodexRequest = null;
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are SUBAGENT." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "next" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBeUndefined();

    // 对照：再来一次同 system A 多轮 → 应仍然能 implicit resume 到 resp-1
    capturedCodexRequest = null;
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are MAIN." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "again" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-1");
  });

  it("Test 6: 同 conv 同 variant 多轮 → 各 variant 有自己的 prev id 链", async () => {
    const sessionId = "shared-session-2";

    // 主对话 turn 1 → resp-1 (vh_main)
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "MAIN" },
          { role: "user", content: "m1" },
        ],
      }),
    });

    // 子代理 turn 1 → resp-2 (vh_sub)
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "SUB" },
          { role: "user", content: "s1" },
        ],
      }),
    });

    // 子代理 turn 2 → 应该续到 resp-2，而不是被主对话的 resp-1 污染
    capturedCodexRequest = null;
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "SUB" },
          { role: "user", content: "s1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "s2" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-2");

    // 主对话 turn 2 → 应该续到 resp-1
    capturedCodexRequest = null;
    await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "MAIN" },
          { role: "user", content: "m1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "m2" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-1");
  });

  it("Test 4: Empty requests do not crash and fallback to random UUID promptCacheKey", async () => {
    const req1 = await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "" }],
      }),
    });
    expect(req1.status).toBe(200);

    // Derived key will be null for empty request, so promptCacheKey will be UUID
    const promptCacheKey = getCapturedCodexRequest().prompt_cache_key;
    expect(promptCacheKey).toBeDefined();
    expect(promptCacheKey?.length).toBeGreaterThan(16); // UUID
  });
});
