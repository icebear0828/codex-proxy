import type { ErrorAction } from "./proxy-error-handler.js";
import {
  buildAccountExhaustionDetail,
  type AccountPoolSummary,
} from "./proxy-error-response.js";

export type ProxyFallbackAvailability =
  | { available: true }
  | { available: false; summary: AccountPoolSummary };

type RetryDecision = Extract<ErrorAction, { action: "retry" }>;

export type ProxyFallbackRetryPlan =
  | { action: "acquire" }
  | {
      action: "respond";
      status: number;
      message: string;
      useFormat429?: true;
    };

export interface BuildProxyFallbackRetryPlanOptions {
  decision: RetryDecision;
  availability: ProxyFallbackAvailability;
}

export function buildProxyFallbackRetryPlan(
  options: BuildProxyFallbackRetryPlanOptions,
): ProxyFallbackRetryPlan {
  const { decision, availability } = options;

  if (availability.available) {
    return { action: "acquire" };
  }

  // Transport retries didn't exhaust the pool in any meaningful sense —
  // "no second account to retry on" is not account exhaustion, and the
  // client should see the transport error itself rather than an
  // exhaustion-prefixed one.
  const message = decision.markTransportRetried
    ? decision.message
    : buildAccountExhaustionDetail(availability.summary, decision.message);

  return {
    action: "respond",
    status: decision.status,
    message,
    ...(decision.useFormat429 ? { useFormat429: true } : {}),
  };
}
