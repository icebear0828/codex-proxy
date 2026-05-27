import { createHash } from "crypto";
import { SessionAffinityMap } from "@src/auth/session-affinity.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { buildProxySessionContext } from "@src/routes/shared/proxy-session-context.js";
import { buildVariantIdentity, resolvePromptCacheIdentity } from "@src/routes/shared/proxy-session-helpers.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { computeVariantHash } from "@src/routes/shared/variant-hash.js";
import { afterEach, describe, expect, it } from "vitest";

const affinityMaps: SessionAffinityMap[] = [];

function makeAffinityMap(): SessionAffinityMap {
  const affinityMap = new SessionAffinityMap();
  affinityMaps.push(affinityMap);
  return affinityMap;
}

function makeCodexRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    instructions: "system",
    input: [{ role: "user", content: "hello" }],
    stream: true,
    store: false,
    ...overrides,
  };
}

function makeProxyRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  const codexRequest = overrides.codexRequest ?? makeCodexRequest();
  return {
    model: codexRequest.model,
    isStreaming: true,
    codexRequest,
    ...overrides,
  };
}

function variantHashFor(request: ProxyRequest): string {
  const identity = resolvePromptCacheIdentity(request.codexRequest, request.clientConversationId);
  return computeVariantHash(
    request.codexRequest.instructions,
    request.codexRequest.tools,
    buildVariantIdentity(request.codexRequest, identity),
  );
}

describe("buildProxySessionContext", () => {
  afterEach(() => {
    for (const affinityMap of affinityMaps) affinityMap.dispose();
    affinityMaps.length = 0;
  });

  it("derives explicit previous-response affinity before account acquisition", () => {
    const affinityMap = makeAffinityMap();
    affinityMap.record(
      "resp_prev",
      "entry-prev",
      "conversation-prev",
      "turn-prev",
      "system",
      33,
      ["call_prev"],
      "variant-prev",
    );
    const request = makeProxyRequest({
      codexRequest: makeCodexRequest({
        previous_response_id: "resp_prev",
        prompt_cache_key: "explicit-cache",
      }),
    });

    const context = buildProxySessionContext({ request, affinityMap });

    expect(context.explicitPrevRespId).toBe("resp_prev");
    expect(context.promptCacheKey).toBe("explicit-cache");
    expect(context.effectiveConversationId).toBe("explicit-cache");
    expect(context.explicitConversationId).toBe("conversation-prev");
    expect(context.chainConversationId).toBe("conversation-prev");
    expect(context.implicitPrevRespId).toBeNull();
    expect(context.prevRespId).toBe("resp_prev");
    expect(context.preferredEntryId).toBe("entry-prev");
    expect(context.explicitTurnState).toBe("turn-prev");
    expect(context.continuationInputStart).toBe(0);
    expect(context.resumeEvaluationInput.implicitPrevRespId).toBeNull();
  });

  it("ignores blank prompt cache and client conversation ids", () => {
    const affinityMap = makeAffinityMap();
    const request = makeProxyRequest({
      clientConversationId: " ",
      codexRequest: makeCodexRequest({
        prompt_cache_key: " ",
      }),
    });

    const context = buildProxySessionContext({ request, affinityMap });

    expect(context.promptCacheKey).not.toBe("");
    expect(context.promptCacheKey).not.toBe(" ");
    expect(context.effectiveConversationId).toBe(context.promptCacheKey);
  });

  it("derives an implicit previous response for the matching conversation variant", () => {
    const affinityMap = makeAffinityMap();
    const request = makeProxyRequest({
      clientConversationId: "client-thread",
      codexRequest: makeCodexRequest({
        input: [
          { role: "user", content: "call the tool" },
          { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_a", output: "done" },
        ],
        tools: [{ type: "function", name: "lookup" }],
        codexWindowId: "window-1",
      }),
    });
    const variantHash = variantHashFor(request);
    affinityMap.record(
      "resp_implicit",
      "entry-implicit",
      "client-thread",
      "turn-implicit",
      "system",
      55,
      ["call_a"],
      variantHash,
    );
    affinityMap.record(
      "resp_wrong_variant",
      "entry-wrong",
      "client-thread",
      "turn-wrong",
      "system",
      55,
      ["call_a"],
      "other-variant",
    );

    const context = buildProxySessionContext({ request, affinityMap });

    expect(context.promptCacheKey).toBe("client-thread");
    expect(context.explicitConversationId).toBeNull();
    expect(context.chainConversationId).toBe("client-thread");
    expect(context.variantHash).toBe(variantHash);
    expect(context.implicitPrevRespId).toBe("resp_implicit");
    expect(context.prevRespId).toBe("resp_implicit");
    expect(context.preferredEntryId).toBe("entry-implicit");
    expect(context.explicitTurnState).toBeNull();
    expect(context.implicitStoredInstructionsHash).toBe(sha256("system"));
    expect(context.implicitStoredFunctionCallIds).toEqual(["call_a"]);
    expect(context.requiredFunctionCallOutputIds).toEqual(["call_a"]);
    expect(context.implicitContinuationInput).toEqual([
      { type: "function_call_output", call_id: "call_a", output: "done" },
    ]);
    expect(context.resumeEvaluationInput).toEqual({
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry-implicit",
      currentInstructions: "system",
      storedInstructionsHash: sha256("system"),
      requiredFunctionCallOutputIds: ["call_a"],
      storedFunctionCallIds: ["call_a"],
      inlineFunctionCallIds: ["call_a"],
    });
  });
});
