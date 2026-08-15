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
    expect(headers["thread-id"]).toBe(headers["session-id"]);
    expect(headers).not.toHaveProperty("session_id");
    expect(headers).not.toHaveProperty("thread_id");
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
});
