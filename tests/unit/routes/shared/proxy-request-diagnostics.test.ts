import { describe, expect, it } from "vitest";
import { buildRequestDiagnostics } from "@src/routes/shared/proxy-request-diagnostics.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";

function createRequest(overrides: Partial<ProxyRequest["codexRequest"]> = {}): ProxyRequest {
  return {
    model: "codex-model",
    isStreaming: false,
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "Hello" }],
      stream: true,
      store: false,
      ...overrides,
    },
  };
}

describe("buildRequestDiagnostics", () => {
  it("builds the compact request summary line", () => {
    const diagnostics = buildRequestDiagnostics({
      tag: "Responses",
      entryId: "entry-1",
      requestId: "request-abcdef",
      request: createRequest({
        tools: [{ type: "function", name: "lookup" }],
        reasoning: { effort: "high", summary: "auto" },
      }),
      chainConversationId: "conversation-abcdef",
      promptCacheKey: "prompt-cache-abcdef",
      variantHash: "variant-hash",
      explicitPrevRespId: undefined,
      implicitPrevRespId: null,
      prevRespId: undefined,
      resumeActive: false,
      resumeReason: "no_previous_response",
      preferredEntryId: null,
    });

    expect(diagnostics.summary).toContain("[Responses] Account entry-1 | model=codex-model | rid=request-");
    expect(diagnostics.summary).toContain("conv=conversa");
    expect(diagnostics.summary).toContain("key=prompt-c");
    expect(diagnostics.summary).toContain("vh=variant-hash prev=none");
    expect(diagnostics.summary).toContain("input_items=1 tools=1 instr=15B");
    expect(diagnostics.summary).toContain("reasoning=[effort=high summary=auto]");
    expect(diagnostics.largePayloadWarning).toBeUndefined();
  });

  it("shows explicit previous response and affinity hit", () => {
    const diagnostics = buildRequestDiagnostics({
      tag: "Chat",
      entryId: "entry-1",
      requestId: "rid-123456789",
      request: createRequest(),
      chainConversationId: "conversation-1",
      promptCacheKey: "cache-1",
      variantHash: "vh",
      explicitPrevRespId: "resp_explicit_12345678",
      implicitPrevRespId: null,
      prevRespId: "resp_explicit_12345678",
      resumeActive: false,
      preferredEntryId: "entry-1",
    });

    expect(diagnostics.summary).toContain("prev=explicit:12345678 resume=explicit");
    expect(diagnostics.summary).toContain("affinity=hit");
  });

  it("shows implicit resume status and affinity miss", () => {
    const diagnostics = buildRequestDiagnostics({
      tag: "Chat",
      entryId: "entry-2",
      requestId: "rid-123456789",
      request: createRequest(),
      chainConversationId: null,
      promptCacheKey: "cache-1",
      variantHash: "vh",
      explicitPrevRespId: undefined,
      implicitPrevRespId: "resp_implicit_87654321",
      prevRespId: "resp_implicit_87654321",
      resumeActive: false,
      resumeReason: "instructions_mismatch",
      preferredEntryId: "entry-1",
    });

    expect(diagnostics.summary).toContain("conv=none");
    expect(diagnostics.summary).toContain("prev=implicit:87654321 resume=off:instructions_mismatch");
    expect(diagnostics.summary).toContain("affinity=miss");
  });

  it("includes a per-item warning for large payloads", () => {
    const largeContent = "x".repeat(50_100);
    const diagnostics = buildRequestDiagnostics({
      tag: "Responses",
      entryId: "entry-1",
      requestId: "request-abcdef",
      request: createRequest({
        instructions: "System",
        input: [
          { role: "user", content: largeContent },
          { type: "message", content: "small" },
        ],
      }),
      chainConversationId: "conversation-abcdef",
      promptCacheKey: "prompt-cache-abcdef",
      variantHash: "variant-hash",
      explicitPrevRespId: undefined,
      implicitPrevRespId: null,
      prevRespId: undefined,
      resumeActive: false,
      preferredEntryId: null,
    });

    expect(diagnostics.largePayloadWarning).toContain("[Responses] ⚠ Large payload");
    expect(diagnostics.largePayloadWarning).toContain("input_items=2 instr=6B");
    expect(diagnostics.largePayloadWarning).toContain("  instructions: 6B");
    expect(diagnostics.largePayloadWarning).toContain("  [0] user ");
    expect(diagnostics.largePayloadWarning).toContain("  [1] message ");
  });
});
