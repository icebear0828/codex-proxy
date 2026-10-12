import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { buildDisplayModelName, parseModelName } from "@src/models/model-store.js";

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
      model: "codex-model",
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

  it("records reasoning and service tier in the upstream request summary", () => {
    recordProxyEgressLog({
      requestId: "rid-reasoning",
      request: createRequest({
        reasoning: { effort: "xhigh", summary: "auto" },
        service_tier: "fast",
      }),
      status: 200,
      startMs: 1_000,
      nowMs: () => 1_515,
    });

    expect(enqueueLogEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        model: "codex-model",
        stream: true,
        useWebSocket: true,
        reasoning: { effort: "xhigh", summary: "auto" },
        service_tier: "fast",
      },
    }));
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

  it("records optional upstream request errors", () => {
    recordProxyEgressLog({
      requestId: "rid-error",
      request: createRequest({ stream: false, useWebSocket: false }),
      status: null,
      startMs: 100,
      nowMs: () => 175,
      error: "upstream request failed",
    });

    expect(enqueueLogEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "rid-error",
      status: null,
      latencyMs: 75,
      error: "upstream request failed",
      request: {
        model: "codex-model",
        stream: false,
        useWebSocket: false,
      },
    }));
  });
});

/**
 * Issue #848 — the egress "upstream model" column must name the model that
 * actually went to the upstream, never a local processing suffix.
 *
 * chat.ts gives `ProxyRequest.model` a *display* name built with
 * `buildDisplayModelName(parseModelName(...))`, which re-appends the `-high` /
 * `-fast` suffixes the resolver had just stripped; the resolved id lives on
 * `codexRequest.model`. These cases drive the real resolver instead of
 * hand-written fixtures, so they cover the whole `gpt-6-high → gpt-6-astra`
 * chain the issue reports.
 */
describe("recordProxyEgressLog — upstream model (issue #848)", () => {
  beforeEach(() => {
    enqueueLogEntryMock.mockReset();
  });

  /** Mirrors the ProxyRequest chat.ts assembles for a client model name. */
  function requestFor(clientModel: string, upstreamModel?: string): ProxyRequest {
    const parsed = parseModelName(clientModel);
    return {
      model: buildDisplayModelName(parsed),
      isStreaming: true,
      codexRequest: {
        model: upstreamModel ?? parsed.modelId,
        instructions: "Be concise",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
        store: false,
      },
    };
  }

  function logEgressFor(clientModel: string, upstreamModel?: string) {
    recordProxyEgressLog({
      requestId: "rid-848",
      request: requestFor(clientModel, upstreamModel),
      status: 200,
      startMs: 1_000,
      nowMs: () => 1_000,
    });
    return enqueueLogEntryMock.mock.calls[0]?.[0];
  }

  it("records the resolved model for a -high request instead of the display name", () => {
    const entry = logEgressFor("gpt-6-high");

    expect(entry?.model).toBe("gpt-6-astra");
    expect(entry?.model).not.toBe("gpt-6-astra-high");
    expect(entry?.request).toMatchObject({ model: "gpt-6-astra" });
  });

  it("records the resolved model for a -fast request instead of the display name", () => {
    const entry = logEgressFor("gpt-6-fast");

    expect(entry?.model).toBe("gpt-6-astra");
    expect(entry?.model).not.toBe("gpt-6-astra-fast");
  });

  it("leaves a model that carries no local suffix unchanged", () => {
    expect(logEgressFor("gpt-6-astra")?.model).toBe("gpt-6-astra");
  });

  it("does not strip a legitimate suffix off the resolved model", () => {
    // A model whose real id ends in an effort word (parseModelName returns such
    // names verbatim when they are catalogued — see model-store.test.ts). The
    // logger must read the id, not re-derive it, or it would mangle the name.
    expect(logEgressFor("gpt-5.3-codex-high", "gpt-5.3-codex-high")?.model)
      .toBe("gpt-5.3-codex-high");
  });
});
