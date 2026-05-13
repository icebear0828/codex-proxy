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

  return {
    action: "respond",
    status: decision.status,
    message: buildAccountExhaustionDetail(availability.summary, decision.message),
    ...(decision.useFormat429 ? { useFormat429: true } : {}),
  };
}
