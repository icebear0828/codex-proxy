import { CodexApiError } from "@src/proxy/codex-api.js";
import { buildProxyRetryRecoveryDecision } from "@src/routes/shared/proxy-retry-recovery.js";
import { describe, expect, it } from "vitest";

function codexError(status: number, error: Record<string, unknown>): CodexApiError {
  return new CodexApiError(status, JSON.stringify({ error }));
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
