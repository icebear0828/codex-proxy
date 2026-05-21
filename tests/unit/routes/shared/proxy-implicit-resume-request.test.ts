import { describe, expect, it, vi } from "vitest";
import {
  applyImplicitResumeRequest,
  captureImplicitResumeRequestState,
  restoreImplicitResumeRequestState,
  type ImplicitResumeAffinityLookup,
} from "@src/routes/shared/proxy-implicit-resume-request.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";

function makeProxyRequest(): ProxyRequest {
  return {
    model: "gpt-5.4",
    isStreaming: true,
    codexRequest: {
      model: "gpt-5.4",
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
      instructions: "system-a",
      previous_response_id: "explicit-prev",
      turnState: "turn-original",
      useWebSocket: false,
      stream: true,
      store: false,
    },
  };
}

function makeAffinityLookup(options: {
  turnState?: string | null;
  inputTokens?: number | null;
} = {}): ImplicitResumeAffinityLookup {
  return {
    lookupTurnState: vi.fn(() => options.turnState ?? null),
    lookupInputTokens: vi.fn(() => options.inputTokens ?? null),
  };
}

describe("implicit resume request state helpers", () => {
  it("captures the request fields that implicit resume mutates", () => {
    const request = makeProxyRequest();
    const snapshot = captureImplicitResumeRequestState(request);

    expect(snapshot).toEqual({
      input: request.codexRequest.input,
      previousResponseId: "explicit-prev",
      turnState: "turn-original",
      useWebSocket: false,
      instructions: "system-a",
    });
  });

  it("applies implicit resume by using the previous response id, WebSocket, sliced input, and usage hint", () => {
    const request = makeProxyRequest();
    const affinityMap = makeAffinityLookup({
      turnState: "turn-implicit",
      inputTokens: 123,
    });

    const usageHint = applyImplicitResumeRequest({
      request,
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      affinityMap,
    });

    expect(request.codexRequest.previous_response_id).toBe("resp_implicit");
    expect(request.codexRequest.useWebSocket).toBe(true);
    expect(request.codexRequest.turnState).toBe("turn-implicit");
    expect(request.codexRequest.input).toEqual([
      { role: "user", content: "continue" },
    ]);
    expect(usageHint).toEqual({ reusedInputTokensUpperBound: 123 });
    expect(affinityMap.lookupTurnState).toHaveBeenCalledWith("resp_implicit");
    expect(affinityMap.lookupInputTokens).toHaveBeenCalledWith("resp_implicit");
  });

  it("does not overwrite an existing turn state when the affinity map has none", () => {
    const request = makeProxyRequest();

    applyImplicitResumeRequest({
      request,
      implicitPrevRespId: "resp_no_turn",
      continuationInputStart: 1,
      affinityMap: makeAffinityLookup(),
    });

    expect(request.codexRequest.turnState).toBe("turn-original");
  });

  it("restores the original request fields after an implicit resume retry fallback", () => {
    const request = makeProxyRequest();
    const snapshot = captureImplicitResumeRequestState(request);

    applyImplicitResumeRequest({
      request,
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      affinityMap: makeAffinityLookup({ turnState: "turn-implicit", inputTokens: 123 }),
    });
    request.codexRequest.instructions = "mutated-system";

    restoreImplicitResumeRequestState({ request, snapshot });

    expect(request.codexRequest.previous_response_id).toBe("explicit-prev");
    expect(request.codexRequest.turnState).toBe("turn-original");
    expect(request.codexRequest.useWebSocket).toBe(false);
    expect(request.codexRequest.input).toBe(snapshot.input);
    expect(request.codexRequest.instructions).toBe("system-a");
  });
});
