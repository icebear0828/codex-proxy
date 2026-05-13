import { describe, expect, it } from "vitest";
import {
  buildProxyFallbackRetryPlan,
  type ProxyFallbackAvailability,
} from "@src/routes/shared/proxy-fallback-retry-plan.js";
import type { ErrorAction } from "@src/routes/shared/proxy-error-handler.js";

type RetryDecision = Extract<ErrorAction, { action: "retry" }>;

const baseRetryDecision = {
  action: "retry",
  status: 429,
  message: "Rate limited",
  useFormat429: true,
} satisfies RetryDecision;

const exhaustedAvailability = {
  available: false,
  summary: {
    total: 2,
    active: 0,
    expired: 0,
    quota_exhausted: 0,
    rate_limited: 2,
    refreshing: 0,
    disabled: 0,
    banned: 0,
  },
} satisfies ProxyFallbackAvailability;

describe("buildProxyFallbackRetryPlan", () => {
  it("continues to fallback account acquisition when an untried account is available", () => {
    const plan = buildProxyFallbackRetryPlan({
      decision: baseRetryDecision,
      availability: { available: true },
    });

    expect(plan).toEqual({ action: "acquire" });
  });

  it("returns a formatted exhaustion response plan when no retry account remains", () => {
    const plan = buildProxyFallbackRetryPlan({
      decision: baseRetryDecision,
      availability: exhaustedAvailability,
    });

    expect(plan).toEqual({
      action: "respond",
      status: 429,
      message: "All accounts exhausted (2 rate-limited). Rate limited",
      useFormat429: true,
    });
  });

  it("does not add format429 when the retry decision does not request it", () => {
    const plan = buildProxyFallbackRetryPlan({
      decision: {
        action: "retry",
        status: 401,
        message: "Unauthorized",
      },
      availability: exhaustedAvailability,
    });

    expect(plan).toEqual({
      action: "respond",
      status: 401,
      message: "All accounts exhausted (2 rate-limited). Unauthorized",
    });
  });
});
