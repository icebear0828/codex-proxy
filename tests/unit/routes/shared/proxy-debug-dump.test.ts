import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexResponsesRequest } from "@src/proxy/codex-api.js";

vi.mock("@src/utils/debug-dump.js", () => ({
  debugDumpEnabled: vi.fn(),
  debugDump: vi.fn(),
}));

const debugDumpModule = await import("@src/utils/debug-dump.js");
const { dumpProxyRequest } = await import("@src/routes/shared/proxy-debug-dump.js");

const debugDumpEnabledMock = vi.mocked(debugDumpModule.debugDumpEnabled);
const debugDumpMock = vi.mocked(debugDumpModule.debugDump);

function createCodexRequest(): CodexResponsesRequest {
  return {
    model: "codex-model",
    instructions: "Be concise",
    input: [{ role: "user", content: "Hello" }],
    stream: true,
    store: false,
  };
}

describe("dumpProxyRequest", () => {
  beforeEach(() => {
    debugDumpEnabledMock.mockReset();
    debugDumpMock.mockReset();
  });

  it("does not build a debug dump when debug dumping is disabled", () => {
    debugDumpEnabledMock.mockReturnValue(false);

    dumpProxyRequest({
      requestId: "rid-123456",
      tag: "Responses",
      entryId: "entry-1",
      conversationId: "conversation-1",
      implicitResumeActive: false,
      resumeReason: "no_previous_response",
      payload: createCodexRequest(),
    });

    expect(debugDumpMock).not.toHaveBeenCalled();
  });

  it("dumps request context and preserves the request payload by reference", () => {
    debugDumpEnabledMock.mockReturnValue(true);
    const payload = createCodexRequest();

    dumpProxyRequest({
      requestId: "rid-123456",
      tag: "Chat",
      entryId: "entry-1",
      conversationId: undefined,
      implicitResumeActive: true,
      resumeReason: null,
      payload,
    });

    expect(debugDumpMock).toHaveBeenCalledWith("request", {
      rid: "rid-123456",
      tag: "Chat",
      entryId: "entry-1",
      conv: null,
      implicitResumeActive: true,
      resumeReason: null,
      payload,
    });
  });

  it("uses the caller-provided resume reason instead of deriving it from mutable resume state", () => {
    debugDumpEnabledMock.mockReturnValue(true);

    dumpProxyRequest({
      requestId: "rid-123456",
      tag: "Messages",
      entryId: "entry-2",
      conversationId: "conversation-1",
      implicitResumeActive: false,
      resumeReason: null,
      payload: createCodexRequest(),
    });

    expect(debugDumpMock).toHaveBeenCalledWith(
      "request",
      expect.objectContaining({
        implicitResumeActive: false,
        resumeReason: null,
      }),
    );
  });
});
