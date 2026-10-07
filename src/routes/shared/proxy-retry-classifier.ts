/**
 * Retry classification — pure function that decides what to do after a
 * CodexApiError, without performing side effects.
 *
 * Extracted from the proxy-handler for-loop to enable independent unit testing
 * of each retry path and their priority interactions.
 */

import { CodexApiError, PreviousResponseWebSocketError } from "../../proxy/codex-api.js";
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
  /** True when the downstream client supplied previous_response_id explicitly.
   *  The proxy has no guaranteed full transcript for this request. */
  explicitPreviousResponseId?: boolean;
  /** One-shot guard: the explicit-chain dead-owner reconnect was already
   *  tried for this request. */
  deadOwnerReconnectDone?: boolean;
}

export type RetryAction =
  | { type: "implicit_resume_replay" }
  | { type: "dead_owner_reconnect" }
  | { type: "strip_and_retry"; kind: "previous_response_not_found" | "unanswered_function_call" }
  | { type: "error_handler_decides" }
  | { type: "not_codex_error" };

/** Continuity reasons where the local pool lost or failed the owning
 *  WebSocket, but the upstream response chain may still be intact (the
 *  response typically completed before the pooled connection was lost).
 *  The same request can then be retried once on a fresh recovery WS and
 *  upstream adjudicates the id. "busy" is a live sibling branch and
 *  account_mismatch / disabled / no_key are deliberate cross-account
 *  fail-closed guards — those must keep failing closed. */
const DEAD_OWNER_RECONNECT_REASONS = new Set([
  "missing_owner",
  "dead",
  "expired",
  "transport",
]);

// ── Classifier ────────────────────────────────────────────────────

/**
 * Classify the retry action for a caught error during an upstream attempt.
 *
 * Priority order:
 *   1. Implicit resume replay (WebSocket failures on resumed connections)
 *   2. Explicit-chain dead-owner reconnect (stale owner, chain may live upstream)
 *   3. Strip previous_response_id (stale session references)
 *   4. Error handler (429/4xx/5xx → fallback account or respond)
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

  // Priority 2: the pooled WS owning an explicit previous_response_id died
  // locally (evicted after a 1006, expired, or failed transport) while the
  // response chain is likely still valid upstream. Retry the same request
  // once on a fresh recovery WS instead of failing the conversation closed.
  if (
    !state.deadOwnerReconnectDone &&
    state.explicitPreviousResponseId &&
    state.previousResponseId &&
    err instanceof PreviousResponseWebSocketError &&
    err.continuityReason !== undefined &&
    DEAD_OWNER_RECONNECT_REASONS.has(err.continuityReason)
  ) {
    return { type: "dead_owner_reconnect" };
  }

  // Priority 3: strip stale implicit previous_response_id (only once).
  // Explicit Responses continuations may contain delta-only input, so stripping
  // their ID would silently lose history; fail closed through the error handler.
  if (!state.stripAndRetryDone && !state.explicitPreviousResponseId) {
    if (isPreviousResponseNotFoundError(err)) {
      return { type: "strip_and_retry", kind: "previous_response_not_found" };
    }
    if (isUnansweredFunctionCallError(err)) {
      return { type: "strip_and_retry", kind: "unanswered_function_call" };
    }
  }

  // Priority 4: delegate to error handler (429/ban/expired/5xx → fallback or respond)
  return { type: "error_handler_decides" };
}
