import { vi } from "vitest";
import { Hono } from "hono";
import type { CodexResponsesRequest } from "@src/proxy/codex-api.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
import type { FormatAdapter } from "@src/routes/shared/proxy-handler-types.js";
import { getSessionAffinityMap } from "@src/auth/session-affinity.js";

// ── State ──────────────────────────────────────────────────────────
export const mockState = {
  responseIdCount: 0,
};

export const mockConfig = {
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

// ── Mocks ──────────────────────────────────────────────────────────
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

export let capturedCodexRequest: CodexResponsesRequest | null = null;
export let capturedCodexRequests: CodexResponsesRequest[] = [];

export function resetCapturedRequests(): void {
  capturedCodexRequest = null;
  capturedCodexRequests = [];
}

export function setCapturedCodexRequest(req: CodexResponsesRequest | null): void {
  capturedCodexRequest = req;
}

export function getCapturedCodexRequest(): CodexResponsesRequest {
  if (!capturedCodexRequest) {
    throw new Error("Expected Codex request to be captured");
  }
  return capturedCodexRequest;
}

export function getCapturedCodexRequests(): CodexResponsesRequest[] {
  return capturedCodexRequests;
}

vi.mock("@src/proxy/codex-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/proxy/codex-api.js")>();
  return {
    ...actual,
    CodexApi: vi.fn().mockImplementation(() => ({
      createResponse: vi.fn(async (req: CodexResponsesRequest) => {
        const snapshot = structuredClone(req);
        capturedCodexRequest = snapshot;
        capturedCodexRequests.push(snapshot);
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
  collectCodexResponse: vi.fn(async (_api, _resp, _model, _wantReasoning, _tuple, _usageHint, _onMetadata) => {
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

export const directProxyFormat: FormatAdapter = {
  tag: "DirectProxyTest",
  noAccountStatus: 503,
  formatNoAccount: () => ({ error: "no_account" }),
  format429: (message) => ({ error: message }),
  formatError: (_status, message) => ({ error: message }),
  streamTranslator: async function* () {
    return;
  },
  collectTranslator: async () => {
    mockState.responseIdCount++;
    const id = `resp-${mockState.responseIdCount}`;
    return {
      response: { id },
      usage: { input_tokens: 10, output_tokens: 5 },
      responseId: id,
    };
  },
};

export function createDirectProxyRoutes(pool: AccountPool): Hono {
  const app = new Hono();
  app.post("/direct", async (c) => {
    const codexRequest = await c.req.json<CodexResponsesRequest>();
    return handleProxyRequest({
      c,
      accountPool: pool,
      req: {
        codexRequest,
        model: codexRequest.model,
        isStreaming: false,
      },
      fmt: directProxyFormat,
    });
  });
  return app;
}

export interface ImplicitResumeContext {
  pool: AccountPool;
  chatApp: Hono;
  geminiApp: Hono;
  directProxyApp: Hono;
}

export function createImplicitResumeTestContext(): ImplicitResumeContext {
  resetCapturedRequests();
  mockState.responseIdCount = 0;
  delete process.env.CODEX_JWT_TOKEN;
  const pool = new AccountPool();
  pool.addAccount("test-token-1");
  const chatApp = createChatRoutes(pool);
  const geminiApp = createGeminiRoutes(pool);
  const directProxyApp = createDirectProxyRoutes(pool);
  return { pool, chatApp, geminiApp, directProxyApp };
}

export function cleanupImplicitResumeTestContext(ctx?: ImplicitResumeContext): void {
  ctx?.pool?.destroy();
  getSessionAffinityMap().dispose();
}
