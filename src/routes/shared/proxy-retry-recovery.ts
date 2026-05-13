import {
  isPreviousResponseNotFoundError,
  isUnansweredFunctionCallError,
} from "../../proxy/error-classification.js";
import { stripCodexErrorPrefix } from "./proxy-handler-utils.js";

export type ProxyRetryRecoveryKind =
  | "previous_response_not_found"
  | "unanswered_function_call";

export type ProxyRetryRecoveryDecision =
  | {
    action: "retry";
    kind: ProxyRetryRecoveryKind;
    staleId?: string;
    logMessage: string;
  }
  | { action: "none" };

export interface BuildProxyRetryRecoveryDecisionOptions {
  err: unknown;
  tag: string;
  entryId: string;
  stripAndRetryDone: boolean;
  previousResponseId: string | undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildProxyRetryRecoveryDecision({
  err,
  tag,
  entryId,
  stripAndRetryDone,
  previousResponseId,
}: BuildProxyRetryRecoveryDecisionOptions): ProxyRetryRecoveryDecision {
  if (stripAndRetryDone) {
    return { action: "none" };
  }

  if (isPreviousResponseNotFoundError(err)) {
    return {
      action: "retry",
      kind: "previous_response_not_found",
      staleId: previousResponseId,
      logMessage:
        `[${tag}] Account ${entryId} | previous_response_not_found (id=${previousResponseId ?? "?"}), stripping and retrying same account`,
    };
  }

  if (isUnansweredFunctionCallError(err)) {
    const message = stripCodexErrorPrefix(errorMessage(err)).slice(0, 200);
    return {
      action: "retry",
      kind: "unanswered_function_call",
      staleId: previousResponseId,
      logMessage:
        `[${tag}] Account ${entryId} | unanswered_function_call (id=${previousResponseId ?? "?"}): ${message}, stripping and retrying same account`,
    };
  }

  return { action: "none" };
}
