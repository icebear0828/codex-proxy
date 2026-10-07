import { describe, it, expect } from "vitest";
import { classifyRetryAction, type RetryState } from "@src/routes/shared/proxy-retry-classifier.js";
import { CodexApiError, PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";

function makeError(status: number, body: string): CodexApiError {
  return new CodexApiError(status, body);
}

const prevRespNotFound = makeError(400, JSON.stringify({
  error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Not found" },
}));

const unansweredFn = makeError(400, JSON.stringify({
  error: { type: "invalid_request_error", message: "No tool output found for function call call_abc." },
}));

const rateLimitErr = makeError(429, JSON.stringify({
  error: { type: "rate_limit_error", message: "Rate limited" },
}));

const serverErr = makeError(502, "Bad Gateway");

const defaultState: RetryState = {
  stripAndRetryDone: false,
  modelRetried: false,
  implicitResumeActive: false,
  previousResponseId: undefined,
};

const neverReplayable = () => false;
const alwaysReplayable = () => true;

describe("classifyRetryAction", () => {
  describe("priority 1: implicit resume replay", () => {
    it("returns implicit_resume_replay when active and error is replayable", () => {
      const state: RetryState = { ...defaultState, implicitResumeActive: true };
      const result = classifyRetryAction(rateLimitErr, state, alwaysReplayable);
      expect(result).toEqual({ type: "implicit_resume_replay" });
    });

    it("skips replay when implicit resume is not active", () => {
      const result = classifyRetryAction(rateLimitErr, defaultState, alwaysReplayable);
      expect(result.type).not.toBe("implicit_resume_replay");
    });

    it("skips replay when error is not replayable", () => {
      const state: RetryState = { ...defaultState, implicitResumeActive: true };
      const result = classifyRetryAction(rateLimitErr, state, neverReplayable);
      expect(result.type).toBe("error_handler_decides");
    });
  });

  describe("priority 2: strip and retry", () => {
    it("returns strip_and_retry for previous_response_not_found", () => {
      const result = classifyRetryAction(prevRespNotFound, defaultState, neverReplayable);
      expect(result).toEqual({ type: "strip_and_retry", kind: "previous_response_not_found" });
    });

    it("returns strip_and_retry for unanswered function call", () => {
      const result = classifyRetryAction(unansweredFn, defaultState, neverReplayable);
      expect(result).toEqual({ type: "strip_and_retry", kind: "unanswered_function_call" });
    });

    it("does NOT strip when stripAndRetryDone is true (loop guard)", () => {
      const state: RetryState = { ...defaultState, stripAndRetryDone: true };
      const result = classifyRetryAction(prevRespNotFound, state, neverReplayable);
      expect(result.type).toBe("error_handler_decides");
    });

    it("does NOT strip when stripAndRetryDone even for unanswered", () => {
      const state: RetryState = { ...defaultState, stripAndRetryDone: true };
      const result = classifyRetryAction(unansweredFn, state, neverReplayable);
      expect(result.type).toBe("error_handler_decides");
    });
  });

  it("fails closed instead of stripping an explicit previous_response_id", () => {
    const result = classifyRetryAction(prevRespNotFound, {
      ...defaultState,
      previousResponseId: "resp_explicit",
      explicitPreviousResponseId: true,
    }, neverReplayable);

    expect(result).toEqual({ type: "error_handler_decides" });
  });

  describe("priority 3: error handler", () => {
    it("delegates 429 to error handler", () => {
      const result = classifyRetryAction(rateLimitErr, defaultState, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });

    it("delegates 502 to error handler", () => {
      const result = classifyRetryAction(serverErr, defaultState, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });
  });

  describe("non-CodexApiError", () => {
    it("returns not_codex_error for plain Error", () => {
      const result = classifyRetryAction(new Error("boom"), defaultState, neverReplayable);
      expect(result).toEqual({ type: "not_codex_error" });
    });

    it("returns not_codex_error for string throw", () => {
      const result = classifyRetryAction("unexpected", defaultState, neverReplayable);
      expect(result).toEqual({ type: "not_codex_error" });
    });
  });

  describe("priority interactions", () => {
    it("implicit resume takes priority over strip-retry for same error", () => {
      const state: RetryState = { ...defaultState, implicitResumeActive: true };
      const result = classifyRetryAction(prevRespNotFound, state, alwaysReplayable);
      expect(result.type).toBe("implicit_resume_replay");
    });

    it("strip-retry takes priority over error handler for previous_response_not_found", () => {
      const result = classifyRetryAction(prevRespNotFound, defaultState, neverReplayable);
      expect(result.type).toBe("strip_and_retry");
    });

    it("after strip exhausted, falls through to error handler for same error", () => {
      const state: RetryState = { ...defaultState, stripAndRetryDone: true };
      const result = classifyRetryAction(prevRespNotFound, state, neverReplayable);
      expect(result.type).toBe("error_handler_decides");
    });
  });

  describe("priority 2: explicit dead-owner reconnect (#789)", () => {
    const explicitState: RetryState = {
      ...defaultState,
      previousResponseId: "resp_explicit",
      explicitPreviousResponseId: true,
    };

    const continuityErr = (reason: PreviousResponseWebSocketError["continuityReason"]) =>
      new PreviousResponseWebSocketError(`Owning WebSocket is unavailable (${reason})`, reason);

    it.each(["missing_owner", "dead", "expired", "transport"] as const)(
      "returns dead_owner_reconnect for stale owner reason %s",
      (reason) => {
        const result = classifyRetryAction(continuityErr(reason), explicitState, neverReplayable);
        expect(result).toEqual({ type: "dead_owner_reconnect" });
      },
    );

    it.each(["busy", "account_mismatch", "disabled", "no_key", "no_context"] as const)(
      "keeps failing closed for reason %s",
      (reason) => {
        const result = classifyRetryAction(continuityErr(reason), explicitState, neverReplayable);
        expect(result).toEqual({ type: "error_handler_decides" });
      },
    );

    it("keeps failing closed when the reason is undefined (generic WS failure)", () => {
      const err = new PreviousResponseWebSocketError("WebSocket failed");
      const result = classifyRetryAction(err, explicitState, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });

    it("does NOT reconnect twice (loop guard)", () => {
      const state: RetryState = { ...explicitState, deadOwnerReconnectDone: true };
      const result = classifyRetryAction(continuityErr("missing_owner"), state, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });

    it("does NOT reconnect for non-continuity errors on explicit chains", () => {
      const result = classifyRetryAction(rateLimitErr, explicitState, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });

    it("does NOT reconnect for implicit chains — priority 1 replay wins", () => {
      const state: RetryState = { ...defaultState, implicitResumeActive: true };
      const result = classifyRetryAction(continuityErr("missing_owner"), state, alwaysReplayable);
      expect(result).toEqual({ type: "implicit_resume_replay" });
    });

    it("does NOT reconnect without a previousResponseId", () => {
      const result = classifyRetryAction(continuityErr("missing_owner"), {
        ...defaultState,
        explicitPreviousResponseId: true,
      }, neverReplayable);
      expect(result).toEqual({ type: "error_handler_decides" });
    });
  });
});
