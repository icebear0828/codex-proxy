import { CodexApiError } from "@src/proxy/codex-api.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import {
  applyProxyRetryRecoveryDecision,
  buildProxyRetryRecoveryDecision,
} from "@src/routes/shared/proxy-retry-recovery.js";
import { describe, expect, it, vi } from "vitest";

function codexError(status: number, error: Record<string, unknown>): CodexApiError {
  return new CodexApiError(status, JSON.stringify({ error }));
}

function proxyRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "gpt-5.4",
      input: [],
      stream: true,
      store: false,
      previous_response_id: "resp_stale",
      turnState: "turn-state",
    },
    model: "gpt-5.4",
    isStreaming: true,
  };
}

describe("buildProxyRetryRecoveryDecision", () => {
  it("builds a same-account retry decision for stale previous_response_id errors", () => {
    const err = codexError(400, {
      type: "invalid_request_error",
      code: "previous_response_not_found",
      message: "Previous response with id 'resp_stale' not found.",
    });

    const decision = buildProxyRetryRecoveryDecision({
      err,
      tag: "openai",
      entryId: "e1",
      stripAndRetryDone: false,
      previousResponseId: "resp_stale",
    });

    expect(decision).toEqual({
      action: "retry",
      kind: "previous_response_not_found",
      staleId: "resp_stale",
      logMessage: "[openai] Account e1 | previous_response_not_found (id=resp_stale), stripping and retrying same account",
    });
  });

  it("builds a same-account retry decision for unanswered function call errors", () => {
    const cleanMessage = `No tool output found for function call call_123.${"x".repeat(240)}`;
    const err = codexError(400, {
      type: "invalid_request_error",
      message: cleanMessage,
    });

    const decision = buildProxyRetryRecoveryDecision({
      err,
      tag: "anthropic",
      entryId: "e2",
      stripAndRetryDone: false,
      previousResponseId: "resp_fn",
    });

    expect(decision).toEqual({
      action: "retry",
      kind: "unanswered_function_call",
      staleId: "resp_fn",
      logMessage: `[anthropic] Account e2 | unanswered_function_call (id=resp_fn): ${cleanMessage.slice(0, 200)}, stripping and retrying same account`,
    });
  });

  it("does not retry when the strip-and-retry guard already fired", () => {
    const err = codexError(400, {
      type: "invalid_request_error",
      code: "previous_response_not_found",
      message: "Previous response with id 'resp_stale' not found.",
    });

    const decision = buildProxyRetryRecoveryDecision({
      err,
      tag: "openai",
      entryId: "e1",
      stripAndRetryDone: true,
      previousResponseId: "resp_stale",
    });

    expect(decision).toEqual({ action: "none" });
  });

  it("does not retry unrelated Codex API errors", () => {
    const err = codexError(400, {
      type: "invalid_request_error",
      code: "invalid_request",
      message: "Unsupported request shape.",
    });

    const decision = buildProxyRetryRecoveryDecision({
      err,
      tag: "openai",
      entryId: "e1",
      stripAndRetryDone: false,
      previousResponseId: "resp_current",
    });

    expect(decision).toEqual({ action: "none" });
  });
});

describe("applyProxyRetryRecoveryDecision", () => {
  it("applies same-account retry recovery side effects", () => {
    const request = proxyRequest();
    const forget = vi.fn();
    const restoreImplicitResumeRequest = vi.fn(() => {
      request.codexRequest.previous_response_id = "resp_restored";
      request.codexRequest.turnState = "restored-turn-state";
    });
    const log = vi.fn();

    const applied = applyProxyRetryRecoveryDecision({
      decision: {
        action: "retry",
        kind: "previous_response_not_found",
        staleId: "resp_stale",
        logMessage: "[openai] stripping and retrying same account",
      },
      request,
      affinityMap: { forget },
      restoreImplicitResumeRequest,
      log,
    });

    expect(applied).toBe(true);
    expect(log).toHaveBeenCalledWith("[openai] stripping and retrying same account");
    expect(forget).toHaveBeenCalledWith("resp_stale");
    expect(restoreImplicitResumeRequest).toHaveBeenCalled();
    expect(request.codexRequest.previous_response_id).toBeUndefined();
    expect(request.codexRequest.turnState).toBeUndefined();
  });

  it("leaves request and affinity state untouched when no recovery is needed", () => {
    const request = proxyRequest();
    const forget = vi.fn();
    const restoreImplicitResumeRequest = vi.fn();
    const log = vi.fn();

    const applied = applyProxyRetryRecoveryDecision({
      decision: { action: "none" },
      request,
      affinityMap: { forget },
      restoreImplicitResumeRequest,
      log,
    });

    expect(applied).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(restoreImplicitResumeRequest).not.toHaveBeenCalled();
    expect(request.codexRequest.previous_response_id).toBe("resp_stale");
    expect(request.codexRequest.turnState).toBe("turn-state");
  });
});
