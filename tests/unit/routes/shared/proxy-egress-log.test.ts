import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";

vi.mock("@src/logs/entry.js", () => ({
  enqueueLogEntry: vi.fn(),
}));

const logsEntryModule = await import("@src/logs/entry.js");
const { recordProxyEgressLog } = await import("@src/routes/shared/proxy-egress-log.js");

const enqueueLogEntryMock = vi.mocked(logsEntryModule.enqueueLogEntry);

function createRequest(overrides: Partial<ProxyRequest["codexRequest"]> = {}): ProxyRequest {
  return {
    model: "client-model",
    isStreaming: true,
    codexRequest: {
      model: "codex-model",
      instructions: "Be concise",
      input: [{ role: "user", content: "Hello" }],
      stream: true,
      store: false,
      useWebSocket: true,
      ...overrides,
    },
  };
}

describe("recordProxyEgressLog", () => {
  beforeEach(() => {
    enqueueLogEntryMock.mockReset();
  });

  it("records the Codex response egress audit entry with existing metadata", () => {
    recordProxyEgressLog({
      requestId: "rid-123",
      request: createRequest(),
      status: 201,
      startMs: 1_000,
      nowMs: () => 1_125,
    });

    expect(enqueueLogEntryMock).toHaveBeenCalledWith({
      requestId: "rid-123",
      direction: "egress",
      method: "POST",
      path: "/codex/responses",
      model: "client-model",
      provider: "codex",
      status: 201,
      latencyMs: 125,
      stream: true,
      request: {
        model: "codex-model",
        stream: true,
        useWebSocket: true,
      },
    });
  });

  it("preserves nullable status and undefined websocket metadata", () => {
    recordProxyEgressLog({
      requestId: "rid-456",
      request: createRequest({ useWebSocket: undefined }),
      status: null,
      startMs: 50,
      nowMs: () => 80,
    });

    expect(enqueueLogEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      status: null,
      latencyMs: 30,
      request: {
        model: "codex-model",
        stream: true,
        useWebSocket: undefined,
      },
    }));
  });
});
