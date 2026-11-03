/**
 * Safety-policy quarantine on the account-pool streaming path.
 *
 * `/v1/responses` on the account path commits the HTTP response before the
 * upstream terminal frame arrives, so a policy rejection there can never be
 * turned into a 4xx. The only place that remembers it is `handleStreaming`'s
 * `finally` block, which feeds the same conversation guard the direct path
 * uses. That block is a distinct code site from its twin in
 * `direct-request-handler.ts` (covered by
 * `direct-request-handler-policy-guard.test.ts`), and this file is its
 * regression guard: without it, deleting the recording would leave every
 * suite green while the account path silently stops quarantining.
 *
 * The chain under test is the real one — `PASSTHROUGH_FORMAT` -> `streamPassthrough`
 * terminal frame -> `onResponseMetadata` -> `recordConversationQuarantine` —
 * with only the upstream transport faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SessionAffinityMap } from "@src/auth/session-affinity.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { CodexApi } from "@src/proxy/codex-api.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";

const guardConfig = {
  enabled: true,
  error_codes: ["cyber_policy", "session_blocked_by_cyber_policy"],
  message_patterns: ["possible cybersecurity risk", "网络安全策略屏蔽"],
  status_codes: [] as number[],
  ttl_seconds: 3600,
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    policy_guard: guardConfig,
    observability: { local_error_log: false },
  })),
}));

const { handleStreaming } = await import("@src/routes/shared/streaming-handler.js");
const { PASSTHROUGH_FORMAT } = await import("@src/routes/responses-passthrough.js");
const {
  peekConversationQuarantine,
  _resetAllConversationQuarantines,
} = await import("@src/proxy/conversation-quarantine.js");

const CONVERSATION_ID = "conversation-policy-stream";

const POLICY_MESSAGE =
  "该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session";

function createStreamingRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "question about a security scanner" }],
      stream: true,
    },
    model: "codex",
    isStreaming: true,
  } as ProxyRequest;
}

function createMockAccountPool(): AccountPool {
  return { release: vi.fn(), getEntry: vi.fn() } as unknown as AccountPool;
}

/** Upstream frames as `streamPassthrough` consumes them. */
function createUpstream(frames: Array<{ event: string; data: unknown }>): CodexApi {
  return {
    tag: "codex-responses",
    parseStream: async function* () {
      for (const frame of frames) yield frame;
    },
  } as unknown as CodexApi;
}

const CREATED_FRAME = {
  event: "response.created",
  data: { type: "response.created", response: { id: "resp_1" } },
};

function failedFrame(error: { type?: string; code?: string; message: string }): { event: string; data: unknown } {
  return {
    event: "response.failed",
    data: { type: "response.failed", response: { id: "resp_1" }, error },
  };
}

const POLICY_FRAME = failedFrame({
  type: "permission_error",
  code: "session_blocked_by_cyber_policy",
  message: POLICY_MESSAGE,
});

const ORDINARY_FAILURE_FRAME = failedFrame({
  type: "server_error",
  code: "server_is_overloaded",
  message: "Server is overloaded",
});

const affinityMaps: SessionAffinityMap[] = [];

/** Drive one streaming request through `handleStreaming` and drain the SSE. */
async function drive(frames: Array<{ event: string; data: unknown }>): Promise<Response> {
  const affinityMap = new SessionAffinityMap();
  affinityMaps.push(affinityMap);
  const req = createStreamingRequest();
  const app = new Hono();
  app.get("/stream", (c) => handleStreaming({
    c,
    accountPool: createMockAccountPool(),
    req,
    fmt: PASSTHROUGH_FORMAT,
    api: createUpstream(frames),
    response: new Response(""),
    entryId: "entry-policy",
    abortController: new AbortController(),
    released: new Set<string>(),
    requestId: "request-policy-stream",
    affinityMap,
    conversationId: CONVERSATION_ID,
    variantHash: "variant-policy",
  }));

  const res = await app.request("/stream");
  await res.text(); // drain so the finally block runs
  return res;
}

function peek() {
  return peekConversationQuarantine({
    conversationId: CONVERSATION_ID,
    input: createStreamingRequest().codexRequest.input,
  });
}

beforeEach(() => {
  guardConfig.enabled = true;
  _resetAllConversationQuarantines();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const affinityMap of affinityMaps) affinityMap.dispose();
  affinityMaps.length = 0;
  _resetAllConversationQuarantines();
});

describe("handleStreaming — safety-policy quarantine", () => {
  it("quarantines the conversation when the stream ends in a policy terminal frame", async () => {
    const res = await drive([CREATED_FRAME, POLICY_FRAME]);

    // The HTTP response was already committed when the frame arrived; the
    // guard's only enforcement point left is the *next* request.
    expect(res.status).toBe(200);
    expect(peek()).toMatchObject({ blocked: true, code: "session_blocked_by_cyber_policy" });
  });

  it("does not quarantine an ordinary terminal failure", async () => {
    const res = await drive([CREATED_FRAME, ORDINARY_FAILURE_FRAME]);

    expect(res.status).toBe(200);
    expect(peek().blocked).toBe(false);
  });

  it("is inert while the guard is disabled", async () => {
    guardConfig.enabled = false;

    const res = await drive([CREATED_FRAME, POLICY_FRAME]);

    expect(res.status).toBe(200);
    expect(peek().blocked).toBe(false);
  });
});
