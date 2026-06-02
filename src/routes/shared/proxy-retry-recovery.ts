import {
  isPreviousResponseNotFoundError,
  isUnansweredFunctionCallError,
} from "../../proxy/error-classification.js";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
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

export interface ApplyProxyRetryRecoveryDecisionOptions {
  decision: ProxyRetryRecoveryDecision;
  request: ProxyRequest;
  affinityMap: Pick<SessionAffinityMap, "forget">;
  restoreImplicitResumeRequest: () => void;
  log?: (message: string) => void;
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

export function applyProxyRetryRecoveryDecision(
  options: ApplyProxyRetryRecoveryDecisionOptions,
): boolean {
  const {
    decision,
    request,
    affinityMap,
    restoreImplicitResumeRequest,
    log = console.warn,
  } = options;

  if (decision.action !== "retry") {
    return false;
  }

  log(decision.logMessage);
  if (decision.staleId) affinityMap.forget(decision.staleId);
  restoreImplicitResumeRequest();
  request.codexRequest.previous_response_id = undefined;
  request.codexRequest.turnState = undefined;
  return true;
}

export interface ApplyCascadingBanDefenseOptions {
  request: ProxyRequest;
  affinityMap: Pick<SessionAffinityMap, "forget">;
  preferredEntryId: string;
  acquiredEntryId: string;
  preferredStatus: string | undefined;
  explicitPrevRespId: string | undefined;
  tag: string;
}

/** Statuses that indicate a potentially compromised account (ban propagation risk). */
const BAN_RISK_STATUSES = new Set(["banned", "disabled"]);

/**
 * Cross-account session isolation guard (Cascading Ban Defense).
 *
 * Only strips `previous_response_id` / `turnState` when the preferred account
 * is in a ban-risk state (banned / disabled). Normal rotation due to quota
 * exhaustion does NOT trigger stripping — the `previous_response_id` won't
 * work cross-account anyway, but carrying it is harmless and the upstream will
 * simply return a "not found" error that the retry path already handles.
 */
export function applyCascadingBanDefense({
  request,
  affinityMap,
  preferredEntryId,
  acquiredEntryId,
  preferredStatus,
  explicitPrevRespId,
  tag,
}: ApplyCascadingBanDefenseOptions): boolean {
  if (
    acquiredEntryId === preferredEntryId ||
    (!request.codexRequest.previous_response_id && !request.codexRequest.turnState)
  ) {
    return false;
  }

  if (!preferredStatus || !BAN_RISK_STATUSES.has(preferredStatus)) {
    return false;
  }

  console.warn(
    `[${tag}] ⚠️ Account switched from preferred ${preferredEntryId} (${preferredStatus}) to ${acquiredEntryId}. ` +
    `Stripping previous_response_id (${request.codexRequest.previous_response_id}) and turnState to prevent upstream cascading ban.`,
  );
  request.codexRequest.previous_response_id = undefined;
  request.codexRequest.turnState = undefined;
  if (explicitPrevRespId) {
    affinityMap.forget(explicitPrevRespId);
  }
  return true;
}

