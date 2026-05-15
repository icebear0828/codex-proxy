import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { CodexSSEEvent } from "@src/proxy/codex-types.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type {
  FormatAdapter,
  HandleDirectRequestOptions,
  ResponseMetadata,
} from "@src/routes/shared/proxy-handler-types.js";
import type { UpstreamRouter } from "@src/proxy/upstream-router.js";

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
  getDataDir: vi.fn(() => "/tmp/test-responses-metadata"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-metadata-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_path: string, _data: string, _encoding: string, cb: (err: Error | null) => void) => cb(null),
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

const mockHandleDirectRequest = vi.fn(async (options: HandleDirectRequestOptions) => options.c.json({ ok: true }));
vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (options: { c: Context }) => options.c.json({ proxied: true })),
}));
vi.mock("@src/routes/shared/direct-request-handler.js", () => ({
  handleDirectRequest: (options: HandleDirectRequestOptions) => mockHandleDirectRequest(options),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

const functionCallItem = {
  type: "function_call",
  id: "fc_issue_571",
  call_id: "call_issue_571",
  name: "read_file",
  arguments: "{}",
};

function createFunctionCallEvents(): CodexSSEEvent[] {
  return [
    {
      event: "response.created",
      data: { type: "response.created", response: { id: "resp_issue_571" } },
    },
    {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: 0, item: functionCallItem },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_issue_571",
          output: [functionCallItem],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    },
  ];
}

function createMockAdapter(events: CodexSSEEvent[]): UpstreamAdapter {
  return {
    tag: "test-upstream",
    createResponse: vi.fn(async () => new Response()),
    async *parseStream(_response: Response): AsyncGenerator<CodexSSEEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function captureResponsesFormat(): Promise<FormatAdapter> {
  const pool = new AccountPool();
  const adapter = createMockAdapter([]);
  const upstreamRouter = {
    resolveMatch: vi.fn(() => ({ kind: "adapter" as const, adapter })),
  } as unknown as UpstreamRouter;
  const app = createResponsesRoutes(pool, undefined, undefined, upstreamRouter);

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-upstream-model",
      input: [{ role: "user", content: "hello" }],
    }),
  });

  expect(res.status).toBe(200);
  expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
  const [options] = mockHandleDirectRequest.mock.calls[0] as [HandleDirectRequestOptions];
  pool.destroy();
  return options.fmt;
}

describe("Responses passthrough metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadStaticModels();
  });

  it("streams function_call call_id metadata through the Responses format adapter", async () => {
    const format = await captureResponsesFormat();
    const metadata: ResponseMetadata[] = [];

    const chunks: string[] = [];
    for await (const chunk of format.streamTranslator({
      api: createMockAdapter(createFunctionCallEvents()),
      response: new Response(),
      model: "test-upstream-model",
      onUsage: () => {},
      onResponseId: () => {},
      onResponseMetadata: (value) => metadata.push(value),
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("response.output_item.done");
    expect(metadata).toEqual([{ functionCallIds: ["call_issue_571"] }]);
  });

  it("collects function_call call_id metadata through the Responses format adapter", async () => {
    const format = await captureResponsesFormat();
    const metadata: ResponseMetadata[] = [];

    const result = await format.collectTranslator({
      api: createMockAdapter(createFunctionCallEvents()),
      response: new Response(),
      model: "test-upstream-model",
      onResponseMetadata: (value) => metadata.push(value),
    });

    expect(result.responseId).toBe("resp_issue_571");
    expect(metadata).toEqual([{ functionCallIds: ["call_issue_571"] }]);
  });
});
