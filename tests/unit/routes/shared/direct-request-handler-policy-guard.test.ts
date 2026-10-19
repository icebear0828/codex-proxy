/**
 * Safety-policy quarantine on the direct upstream path.
 *
 * `handleDirectRequest` serves API-key/custom upstreams and the last-resort
 * fallback account. It has no retry loop and no account rotation, so the
 * amplification the account path guards against does not exist here — but the
 * client's own retry and its "goal"-mode continuations arrive as brand-new
 * requests on this path, and each resend reports another violation upstream.
 * That makes the same three interception points necessary:
 *
 *   - pre-flight refusal before the upstream is contacted,
 *   - a rejection thrown as an HTTP error (relays answer with a plain 4xx),
 *   - a rejection delivered as an in-stream terminal frame.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const guardConfig = {
  enabled: true,
  error_codes: ["cyber_policy", "session_blocked_by_cyber_policy"],
  message_patterns: ["possible cybersecurity risk", "网络安全策略屏蔽"],
  ttl_seconds: 3600,
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    policy_guard: guardConfig,
    observability: { local_error_log: false },
  })),
}));

const { handleDirectRequest } = await import("@src/routes/shared/direct-request-handler.js");
const { PASSTHROUGH_FORMAT } = await import("@src/routes/responses-passthrough.js");
const { CodexApiError } = await import("@src/proxy/codex-api.js");
const { resolvePromptCacheIdentity } = await import("@src/routes/shared/proxy-session-helpers.js");
const {
  peekConversationQuarantine,
  recordConversationQuarantine,
  _resetAllConversationQuarantines,
} = await import("@src/proxy/conversation-quarantine.js");
const { createMockFormatAdapter } = await import("@helpers/format-adapter.js");

const SUB2API_BODY = JSON.stringify({
  error: {
    type: "permission_error",
    code: "session_blocked_by_cyber_policy",
    message:
      "该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session",
  },
});

function makeRequest(overrides: Partial<import("@src/routes/shared/proxy-handler-types.js").ProxyRequest> = {}) {
  return {
    model: "gpt-5-codex",
    isStreaming: false,
    codexRequest: {
      model: "gpt-5-codex",
      input: [{ role: "user", content: "question about a security scanner" }],
      instructions: "system prompt",
      stream: true,
      store: false,
    },
    ...overrides,
  } as import("@src/routes/shared/proxy-handler-types.js").ProxyRequest;
}

/** The identity the handler derives when the client sends no conversation id. */
function conversationIdOf(req: ReturnType<typeof makeRequest>): string {
  return resolvePromptCacheIdentity(req.codexRequest, req.clientConversationId).conversationId;
}

function makeUpstream(createResponse: (call: number) => Promise<Response>) {
  let calls = 0;
  const fn = vi.fn(async () => createResponse(++calls));
  return { upstream: { tag: "custom-relay", createResponse: fn }, createResponse: fn };
}

async function drive(
  upstream: unknown,
  req: ReturnType<typeof makeRequest>,
  fmt: unknown,
): Promise<Response> {
  const app = new Hono();
  app.post("/test", (c) =>
    handleDirectRequest({ c: c as never, upstream: upstream as never, req, fmt: fmt as never }));
  return app.request("/test", { method: "POST" });
}

beforeEach(() => {
  guardConfig.enabled = true;
  _resetAllConversationQuarantines();
});

describe("handleDirectRequest — safety-policy quarantine", () => {
  it("refuses a quarantined conversation before contacting the upstream", async () => {
    const req = makeRequest();
    recordConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
      code: "session_blocked_by_cyber_policy",
      message: SUB2API_BODY,
    });
    const { upstream, createResponse } = makeUpstream(async () => new Response("{}"));
    const fmt = createMockFormatAdapter();

    const res = await drive(upstream, req, fmt);
    const body = (await res.json()) as { status?: number };

    expect(res.status).toBe(400);
    expect(createResponse).not.toHaveBeenCalled();
    expect(body.status).toBe(400);
  });

  it("releases the conversation once its history changes", async () => {
    const req = makeRequest();
    recordConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
      code: "session_blocked_by_cyber_policy",
      message: "blocked",
    });
    // The client removed the offending turn and re-sent the rest.
    const edited = makeRequest({
      codexRequest: {
        model: "gpt-5-codex",
        input: [{ role: "user", content: "unrelated question" }],
        instructions: "system prompt",
        stream: true,
        store: false,
      },
    });
    const { upstream, createResponse } = makeUpstream(async () => new Response("{}"));

    const res = await drive(upstream, edited, createMockFormatAdapter());

    expect(res.status).toBe(200);
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it("quarantines the conversation when the upstream throws the rejection", async () => {
    const { upstream, createResponse } = makeUpstream(async () => {
      throw new CodexApiError(400, SUB2API_BODY);
    });
    const fmt = createMockFormatAdapter();
    const req = makeRequest();

    const res = await drive(upstream, req, fmt);
    const body = (await res.json()) as { status?: number };

    // Rejected as an upstream safety verdict, not as the relay's own status:
    // a 4xx the client is free to retry is exactly the loop to break.
    expect(res.status).toBe(400);
    expect(body.status).toBe(400);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(peekConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
    })).toMatchObject({ blocked: true, code: "session_blocked_by_cyber_policy" });

    // The next turn of the same conversation never reaches the upstream.
    const second = await drive(upstream, makeRequest(), fmt);
    expect(second.status).toBe(400);
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it("quarantines the conversation on an in-stream terminal rejection frame", async () => {
    const frames = [
      { event: "response.created", data: { type: "response.created", response: { id: "resp_1" } } },
      {
        event: "response.failed",
        data: {
          type: "response.failed",
          response: { id: "resp_1" },
          error: {
            type: "permission_error",
            code: "session_blocked_by_cyber_policy",
            message: "该会话已被网络安全策略屏蔽，请开启新会话",
          },
        },
      },
    ];
    const upstream = {
      tag: "codex-responses",
      createResponse: vi.fn(async () => new Response("data: {}\n\n", { status: 200 })),
      parseStream: async function* () {
        for (const frame of frames) yield frame;
      },
    };
    const req = makeRequest({ isStreaming: true });

    const res = await drive(upstream, req, PASSTHROUGH_FORMAT);
    await res.text(); // drain the stream so the recording completes

    expect(res.status).toBe(200);
    expect(peekConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
    })).toMatchObject({ blocked: true });
  });

  it("quarantines the conversation when a collected stream ends in the rejection frame", async () => {
    // Non-streaming client against a codex-wire upstream: the rejection is a
    // stream frame, and it must not be downgraded to an "empty response"
    // (which is retryable) — the verdict is about the content.
    const frames = [
      { event: "response.created", data: { type: "response.created", response: { id: "resp_1" } } },
      {
        event: "response.failed",
        data: {
          type: "response.failed",
          response: { id: "resp_1" },
          error: {
            type: "permission_error",
            code: "session_blocked_by_cyber_policy",
            message: "该会话已被网络安全策略屏蔽，请开启新会话",
          },
        },
      },
    ];
    const upstream = {
      tag: "codex-responses",
      createResponse: vi.fn(async () => new Response("data: {}\n\n", { status: 200 })),
      parseStream: async function* () {
        for (const frame of frames) yield frame;
      },
    };
    const req = makeRequest();

    const res = await drive(upstream, req, PASSTHROUGH_FORMAT);

    expect(res.status).toBe(400);
    expect(peekConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
    })).toMatchObject({ blocked: true, code: "session_blocked_by_cyber_policy" });
    expect(upstream.createResponse).toHaveBeenCalledTimes(1);
  });

  it("quarantines the conversation when a non-passthrough streaming format throws the rejection", async () => {
    // chat/completions, Anthropic and Gemini translators throw a typed error on
    // a terminal frame; response-processor turns it into an SSE error event and
    // swallows it. The verdict must still reach the caller's quarantine.
    const upstream = {
      tag: "codex-responses",
      createResponse: vi.fn(async () => new Response("data: {}\n\n", { status: 200 })),
    };
    const fmt = createMockFormatAdapter({
      streamTranslator: vi.fn(async function* () {
        throw new CodexApiError(400, SUB2API_BODY);
      }),
    });
    const req = makeRequest({ isStreaming: true });

    const res = await drive(upstream, req, fmt);
    await res.text();

    expect(peekConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
    })).toMatchObject({ blocked: true, code: "session_blocked_by_cyber_policy" });
  });

  it("is inert while the guard is disabled", async () => {
    guardConfig.enabled = false;
    const { upstream, createResponse } = makeUpstream(async () => {
      throw new CodexApiError(400, SUB2API_BODY);
    });
    const req = makeRequest();

    const res = await drive(upstream, req, createMockFormatAdapter());

    // Disabled: the relay's own error body and status are forwarded verbatim,
    // and nothing is remembered.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "session_blocked_by_cyber_policy" } });
    expect(peekConversationQuarantine({
      conversationId: conversationIdOf(req),
      input: req.codexRequest.input,
    }).blocked).toBe(false);
    expect(createResponse).toHaveBeenCalledTimes(1);
  });
});
