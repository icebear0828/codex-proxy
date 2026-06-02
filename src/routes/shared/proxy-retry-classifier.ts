/**
 * Retry classification — pure function that decides what to do after a
 * CodexApiError, without performing side effects.
 *
 * Extracted from the proxy-handler for-loop to enable independent unit testing
 * of each retry path and their priority interactions.
 */

import { CodexApiError } from "../../proxy/codex-api.js";
import {
  isPreviousResponseNotFoundError,
  isUnansweredFunctionCallError,
} from "../../proxy/error-classification.js";

// ── Types ─────────────────────────────────────────────────────────

export interface RetryState {
  stripAndRetryDone: boolean;
  modelRetried: boolean;
  implicitResumeActive: boolean;
  previousResponseId: string | undefined;
}

export type RetryAction =
  | { type: "implicit_resume_replay" }
  | { type: "strip_and_retry"; kind: "previous_response_not_found" | "unanswered_function_call" }
  | { type: "error_handler_decides" }
  | { type: "not_codex_error" };

// ── Classifier ────────────────────────────────────────────────────

/**
 * Classify the retry action for a caught error during an upstream attempt.
 *
 * Priority order:
 *   1. Implicit resume replay (WebSocket failures on resumed connections)
 *   2. Strip previous_response_id (stale session references)
 *   3. Error handler (429/4xx/5xx → fallback account or respond)
 *
 * This is a pure function — no side effects. The caller applies the decision.
 */
export function classifyRetryAction(
  err: unknown,
  state: RetryState,
  isImplicitResumeReplayable: (err: unknown) => boolean,
): RetryAction {
  if (!(err instanceof CodexApiError)) {
    return { type: "not_codex_error" };
  }

  // Priority 1: implicit resume can replay with full input
  if (state.implicitResumeActive && isImplicitResumeReplayable(err)) {
    return { type: "implicit_resume_replay" };
  }

  // Priority 2: strip stale previous_response_id (only once)
  if (!state.stripAndRetryDone) {
    if (isPreviousResponseNotFoundError(err)) {
      return { type: "strip_and_retry", kind: "previous_response_not_found" };
    }
    if (isUnansweredFunctionCallError(err)) {
      return { type: "strip_and_retry", kind: "unanswered_function_call" };
    }
  }

  // Priority 3: delegate to error handler (429/ban/expired/5xx → fallback or respond)
  return { type: "error_handler_decides" };
}
