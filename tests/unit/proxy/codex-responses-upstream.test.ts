import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockConfig } from "@helpers/config.js";
import { loadFingerprint, setConfigForTesting } from "@src/config.js";

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: () => ({
    post: postMock,
    get: vi.fn(),
    simplePost: vi.fn(),
    isImpersonate: () => false,
  }),
}));

vi.mock("@src/proxy/installation-id.js", () => ({
  getInstallationId: () => "11111111-2222-3333-4444-555555555555",
}));

import { CodexResponsesUpstream } from "@src/proxy/codex-responses-upstream.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function responseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function jsonStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Model a strict gateway that requires official identity, a parseable engine
 * version, Codex-prefixed headers, session/thread IDs, and body metadata.
 */
function passesStrictCodexClientMatrix(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): boolean {
  const userAgent = headers["User-Agent"]?.trim().toLowerCase() ?? "";
  const originator = headers.originator?.trim().toLowerCase() ?? "";
  const officialPrefixes = [
    "codex_cli_rs/",
    "codex-tui/",
    "codex_vscode/",
    "codex_vscode_copilot/",
    "codex_app/",
    "codex_chatgpt_desktop/",
    "codex_atlas/",
    "codex_exec/",
    "codex_sdk_ts/",
  ];
  const officialOriginators = new Set(officialPrefixes.map((value) => value.slice(0, -1)));
  const officialIdentity = officialPrefixes.some((prefix) => userAgent.startsWith(prefix))
    || userAgent.startsWith("codex ")
    || officialOriginators.has(originator)
    || originator.startsWith("codex ");
  const versionParsable = /^[^/]+\/\d+\.\d+\.\d+/.test(userAgent);
  const hasCodexHeader = Object.entries(headers).some(
    ([name, value]) => name.toLowerCase().startsWith("x-codex-") && value.trim() !== "",
  );
  const metadata = body.client_metadata as Record<string, unknown> | undefined;
  const hasBodyFingerprint = Boolean(
    metadata?.["x-codex-window-id"] || metadata?.["x-codex-installation-id"],
  );
  return officialIdentity
    && versionParsable
    && hasCodexHeader
    && Boolean(headers["session-id"]?.trim())
    && Boolean(headers["thread-id"]?.trim())
    && hasBodyFingerprint;
}

describe("CodexResponsesUpstream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfigForTesting(createMockConfig({
      client: {
        originator: "Codex Desktop",
        app_version: "26.715.21425",
        platform: "Windows 11",
        arch: "x86_64",
      },
    }));
    loadFingerprint("config");
    postMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: responseStream(),
      setCookieHeaders: [],
    });
  });

  it("uses /responses and sends a complete official-client context", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1/",
      "entry-1",
    );
    const signal = new AbortController().signal;
    const request: CodexResponsesRequest = {
      model: "custom:gpt-5.6-sol",
      instructions: "Be concise",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      prompt_cache_key: "thread-123",
      previous_response_id: "resp_previous",
      include: ["reasoning.encrypted_content"],
      version: "0.0.1",
    };

    await upstream.createResponse(request, signal);

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, headers, rawBody, passedSignal] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
      AbortSignal,
    ];
    expect(url).toBe("https://provider.example.com/v1/responses");
    expect(passedSignal).toBe(signal);
    expect(headers).toMatchObject({
      Authorization: "Bearer sk-vendor",
      originator: "Codex Desktop",
      "User-Agent": "Codex Desktop/26.715.21425 (Windows 11; x86_64)",
      Version: "26.715.21425",
      "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
    });
    expect(headers).not.toHaveProperty("ChatGPT-Account-Id");
    expect(headers["session-id"]).toMatch(/^cp_[0-9a-f]{32}$/);
    expect(headers["session_id"]).toBe(headers["session-id"]);
    expect(headers["thread-id"]).toBe(headers["session-id"]);
    expect(headers["thread_id"]).toBe(headers["session-id"]);
    expect(headers["x-codex-window-id"]).toBe(`${headers["session-id"]}:0`);

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      prompt_cache_key: headers["session-id"],
      previous_response_id: "resp_previous",
      include: ["reasoning.encrypted_content"],
    });
    expect(body.client_metadata).toMatchObject({
      "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      "x-codex-window-id": `${headers["session-id"]}:0`,
    });
    expect(passesStrictCodexClientMatrix(headers, body)).toBe(true);
  });

  it("adds x-opencode-session and keeps the client User-Agent for Console Go upstreams", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://opencode.ai/zen/go/v1/",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      prompt_cache_key: "thread-123",
      clientUserAgent: "codex_cli_rs/0.41.0 (x86_64-apple-darwin) (macos 26.0.0)",
      opencodeSessionId: "session-from-client",
    };

    await upstream.createResponse(request, new AbortController().signal);

    const [, headers] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
    ];
    expect(headers["x-opencode-session"]).toBe("session-from-client");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.41.0 (x86_64-apple-darwin) (macos 26.0.0)");
  });

  it("uses the stable per-conversation id for Console Go when the client sends no session", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://opencode.ai/zen/go/v1/",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      prompt_cache_key: "thread-123",
    };

    await upstream.createResponse(request, new AbortController().signal);

    const [, headers] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
    ];
    expect(headers["x-opencode-session"]).toMatch(/^cp_[0-9a-f]{32}$/);
  });

  it("does not send x-opencode-session to non-OpenCode upstreams", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1/",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      prompt_cache_key: "thread-123",
      opencodeSessionId: "session-from-client",
    };

    await upstream.createResponse(request, new AbortController().signal);

    const [, headers] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
    ];
    expect(headers).not.toHaveProperty("x-opencode-session");
  });

  it("generates complete context for stateless first requests", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
    };

    await upstream.createResponse(request, new AbortController().signal);

    const [, headers, rawBody] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
    ];
    expect(passesStrictCodexClientMatrix(headers, JSON.parse(rawBody))).toBe(true);
  });

  it.each([
    "alpha/search",
    "responses/compact",
    "images/generations",
    "images/edits",
  ] as const)("forwards the exact %s JSON endpoint without rewriting its body", async (path) => {
    postMock.mockResolvedValueOnce({
      status: 202,
      headers: new Headers({ "Content-Type": "application/json", "x-request-id": "upstream-rid" }),
      body: jsonStream({ ok: true }),
      setCookieHeaders: [],
    });
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1/",
      "entry-1",
    );
    const signal = new AbortController().signal;
    const body = {
      id: "request-123",
      model: "custom:gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      provider_extension: { preserved: true },
    };

    const response = await upstream.forwardCodexJsonRequest(path, body, signal, {
      turnState: "turn-state-1",
      parentThreadId: "parent-thread-1",
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBe("upstream-rid");
    await expect(response.json()).resolves.toEqual({ ok: true });
    const [url, headers, rawBody, passedSignal] = postMock.mock.calls[0] as [
      string,
      Record<string, string>,
      string,
      AbortSignal,
    ];
    expect(url).toBe(`https://provider.example.com/v1/${path}`);
    expect(passedSignal).toBe(signal);
    expect(JSON.parse(rawBody)).toEqual(body);
    expect(headers).toMatchObject({
      Accept: "application/json",
      Authorization: "Bearer sk-vendor",
      originator: "Codex Desktop",
      "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      "x-codex-turn-state": "turn-state-1",
      "x-codex-parent-thread-id": "parent-thread-1",
    });
    expect(headers).not.toHaveProperty("ChatGPT-Account-Id");
    expect(headers).not.toHaveProperty("OpenAI-Beta");
    expect(headers["session-id"]).toMatch(/^cp_[0-9a-f]{32}$/);
    expect(headers["thread-id"]).toBe(headers["session-id"]);
  });

  it("rejects paths outside the auxiliary endpoint allowlist before transport", async () => {
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1",
      "entry-1",
    );

    await expect(upstream.forwardCodexJsonRequest(
      "admin/secrets" as "alpha/search",
      { model: "gpt-5.6-sol" },
      new AbortController().signal,
    )).rejects.toThrow("Unsupported Codex auxiliary endpoint");
    expect(postMock).not.toHaveBeenCalled();
  });

  // This wire forwards `req.tools` verbatim (buildResponsesUpstreamBody), so a
  // deterministic tool-schema rejection must be reclassified here too — it is
  // the one adapter that reaches upstream through getTransport() rather than
  // global fetch, and it was missed by the initial round of wiring.
  it("reclassifies a deterministic tool-schema error reported as 502 to 400", async () => {
    const errorBody = "Invalid schema for function 'Artifact': "
      + "'^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$' is not a 'regex'.";
    postMock.mockResolvedValue({
      status: 502,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(errorBody));
          controller.close();
        },
      }),
      setCookieHeaders: [],
    });
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "custom:gpt-5.6-sol",
      instructions: "Be concise",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      tools: [{ type: "function", name: "Artifact", parameters: { type: "object" } }],
    };

    await expect(
      upstream.createResponse(request, new AbortController().signal),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("leaves an ordinary transport 502 alone (no schema-error text)", async () => {
    postMock.mockResolvedValue({
      status: 502,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Bad Gateway"));
          controller.close();
        },
      }),
      setCookieHeaders: [],
    });
    const upstream = new CodexResponsesUpstream(
      "sk-vendor",
      "https://provider.example.com/v1",
      "entry-1",
    );
    const request: CodexResponsesRequest = {
      model: "custom:gpt-5.6-sol",
      instructions: "Be concise",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
    };

    await expect(
      upstream.createResponse(request, new AbortController().signal),
    ).rejects.toMatchObject({ status: 502 });
  });
});
