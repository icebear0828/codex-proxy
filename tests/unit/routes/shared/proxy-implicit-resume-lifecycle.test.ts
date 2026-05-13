import { PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import {
  captureImplicitResumeRequestState,
  type ImplicitResumeAffinityLookup,
} from "@src/routes/shared/proxy-implicit-resume-request.js";
import { createImplicitResumeLifecycle } from "@src/routes/shared/proxy-implicit-resume-lifecycle.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { describe, expect, it, vi } from "vitest";

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

describe("implicit resume lifecycle", () => {
  it("logs skipped missing tool-call output ids without mutating the request", () => {
    const request = makeProxyRequest();
    const snapshot = captureImplicitResumeRequestState(request);
    const warn = vi.fn();

    const lifecycle = createImplicitResumeLifecycle({
      request,
      snapshot,
      affinityMap: makeAffinityLookup(),
      tag: "Test",
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      resumeEvaluationInput: {
        implicitPrevRespId: "resp_implicit",
        continuationInputStart: 2,
        inputLength: 3,
        preferredEntryId: "entry-1",
        currentInstructions: "system-a",
        storedInstructions: "system-a",
        requiredFunctionCallOutputIds: ["call_a"],
        storedFunctionCallIds: ["call_b", "call_c"],
      },
      acquiredEntryId: "entry-1",
      warn,
    });

    lifecycle.logSkippedWarnings();
    lifecycle.activate();

    expect(warn).toHaveBeenCalledWith(
      "[Test] 隐式续链跳过：上一轮 response 未记录 tool_result 对应的 call_id=call_a",
    );
    expect(lifecycle.isActive()).toBe(false);
    expect(lifecycle.getUsageHint()).toBeUndefined();
    expect(request.codexRequest).toMatchObject({
      previous_response_id: "explicit-prev",
      turnState: "turn-original",
      useWebSocket: false,
    });
  });

  it("logs skipped unanswered function-call ids without mutating the request", () => {
    const request = makeProxyRequest();
    const warn = vi.fn();

    const lifecycle = createImplicitResumeLifecycle({
      request,
      snapshot: captureImplicitResumeRequestState(request),
      affinityMap: makeAffinityLookup(),
      tag: "Test",
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      resumeEvaluationInput: {
        implicitPrevRespId: "resp_implicit",
        continuationInputStart: 2,
        inputLength: 3,
        preferredEntryId: "entry-1",
        currentInstructions: "system-a",
        storedInstructions: "system-a",
        requiredFunctionCallOutputIds: ["call_a"],
        storedFunctionCallIds: ["call_a", "call_b", "call_c"],
      },
      acquiredEntryId: "entry-1",
      warn,
    });

    lifecycle.logSkippedWarnings();
    lifecycle.activate();

    expect(warn).toHaveBeenCalledWith(
      "[Test] 隐式续链跳过：上一轮 function_call 未被全部回复，缺 call_id=call_b,call_c",
    );
    expect(lifecycle.isActive()).toBe(false);
    expect(lifecycle.getUsageHint()).toBeUndefined();
    expect(request.codexRequest.previous_response_id).toBe("explicit-prev");
  });

  it("applies eligible implicit resume and restores it on demand", () => {
    const request = makeProxyRequest();
    const snapshot = captureImplicitResumeRequestState(request);
    const lifecycle = createImplicitResumeLifecycle({
      request,
      snapshot,
      affinityMap: makeAffinityLookup({ turnState: "turn-implicit", inputTokens: 123 }),
      tag: "Test",
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      resumeEvaluationInput: {
        implicitPrevRespId: "resp_implicit",
        continuationInputStart: 2,
        inputLength: 3,
        preferredEntryId: "entry-1",
        currentInstructions: "system-a",
        storedInstructions: "system-a",
        requiredFunctionCallOutputIds: [],
        storedFunctionCallIds: [],
      },
      acquiredEntryId: "entry-1",
    });

    lifecycle.activate();

    expect(lifecycle.evaluation).toEqual({ active: true, reason: null });
    expect(lifecycle.isActive()).toBe(true);
    expect(lifecycle.resumeReasonForAttempt()).toBeNull();
    expect(lifecycle.getUsageHint()).toEqual({ reusedInputTokensUpperBound: 123 });
    expect(request.codexRequest.previous_response_id).toBe("resp_implicit");
    expect(request.codexRequest.turnState).toBe("turn-implicit");
    expect(request.codexRequest.useWebSocket).toBe(true);
    expect(request.codexRequest.input).toEqual([{ role: "user", content: "continue" }]);

    lifecycle.restore();
    lifecycle.restore();

    expect(lifecycle.isActive()).toBe(false);
    expect(lifecycle.getUsageHint()).toBeUndefined();
    expect(request.codexRequest.previous_response_id).toBe("explicit-prev");
    expect(request.codexRequest.turnState).toBe("turn-original");
    expect(request.codexRequest.useWebSocket).toBe(false);
    expect(request.codexRequest.input).toBe(snapshot.input);
    expect(request.codexRequest.instructions).toBe("system-a");
  });

  it("logs and restores the full request when an active implicit WebSocket attempt fails", () => {
    const request = makeProxyRequest();
    const snapshot = captureImplicitResumeRequestState(request);
    const warn = vi.fn();
    const lifecycle = createImplicitResumeLifecycle({
      request,
      snapshot,
      affinityMap: makeAffinityLookup({ turnState: "turn-implicit", inputTokens: 123 }),
      tag: "Test",
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      resumeEvaluationInput: {
        implicitPrevRespId: "resp_implicit",
        continuationInputStart: 2,
        inputLength: 3,
        preferredEntryId: "entry-1",
        currentInstructions: "system-a",
        storedInstructions: "system-a",
      },
      acquiredEntryId: "entry-1",
      warn,
    });
    lifecycle.activate();

    const replayed = lifecycle.replayFullInputAfterError(new PreviousResponseWebSocketError("ws down"));

    expect(replayed).toBe(true);
    expect(warn).toHaveBeenCalledWith("[Test] 隐式续链 WebSocket 失败，回退为完整历史重放：ws down");
    expect(lifecycle.isActive()).toBe(false);
    expect(lifecycle.getUsageHint()).toBeUndefined();
    expect(request.codexRequest.previous_response_id).toBe("explicit-prev");
    expect(request.codexRequest.turnState).toBe("turn-original");
    expect(request.codexRequest.useWebSocket).toBe(false);
    expect(request.codexRequest.input).toBe(snapshot.input);
  });

  it("ignores WebSocket replay errors while inactive", () => {
    const request = makeProxyRequest();
    const lifecycle = createImplicitResumeLifecycle({
      request,
      snapshot: captureImplicitResumeRequestState(request),
      affinityMap: makeAffinityLookup(),
      tag: "Test",
      implicitPrevRespId: "resp_implicit",
      continuationInputStart: 2,
      resumeEvaluationInput: {
        implicitPrevRespId: "resp_implicit",
        continuationInputStart: 2,
        inputLength: 3,
        preferredEntryId: "entry-1",
        currentInstructions: "system-a",
        storedInstructions: "system-a",
      },
      acquiredEntryId: "entry-2",
    });

    expect(lifecycle.replayFullInputAfterError(new PreviousResponseWebSocketError("ws down"))).toBe(false);
  });
});
