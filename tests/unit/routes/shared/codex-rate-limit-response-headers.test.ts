import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { forwardCodexRateLimitHeaders } from "@src/routes/shared/codex-rate-limit-response-headers.js";
import type { CodexQuota } from "@src/auth/types.js";

const cachedQuota: CodexQuota = {
  plan_type: "plus",
  rate_limit: {
    used_percent: 33,
    remaining_percent: 67,
    reset_at: 1_786_518_429,
    limit_window_seconds: 604_800,
    allowed: true,
    limit_reached: false,
  },
  secondary_rate_limit: {
    used_percent: 12,
    remaining_percent: 88,
    reset_at: 1_786_700_000,
    limit_window_seconds: 604_800,
    limit_reached: false,
  },
  code_review_rate_limit: null,
  credits: {
    has_credits: false,
    unlimited: false,
    overage_limit_reached: false,
    balance: 0,
  },
};

function responseWithQuotaHeaders(upstreamHeaders: Headers, quota?: CodexQuota): Promise<Response> {
  const app = new Hono();
  app.get("/", (c) => {
    forwardCodexRateLimitHeaders(c, upstreamHeaders, quota);
    return c.text("ok");
  });
  return app.request("/");
}

describe("forwardCodexRateLimitHeaders", () => {
  it("uses cached WebSocket quota when the upstream response has no quota headers", async () => {
    const response = await responseWithQuotaHeaders(new Headers(), cachedQuota);

    expect(response.headers.get("x-codex-primary-used-percent")).toBe("33");
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("10080");
    expect(response.headers.get("x-codex-primary-reset-at")).toBe("1786518429");
    expect(response.headers.get("x-codex-secondary-used-percent")).toBe("12");
    expect(response.headers.get("x-codex-secondary-window-minutes")).toBe("10080");
    expect(response.headers.get("x-codex-secondary-reset-at")).toBe("1786700000");
    expect(response.headers.get("x-codex-credits-has-credits")).toBe("false");
    expect(response.headers.get("x-codex-credits-unlimited")).toBe("false");
    expect(response.headers.get("x-codex-credits-balance")).toBe("0");
  });

  it("preserves upstream values while filling absent values from cached quota", async () => {
    const response = await responseWithQuotaHeaders(new Headers({
      "x-codex-primary-used-percent": "44",
      "x-codex-primary-window-minutes": "300",
      "x-codex-active-limit": "secondary",
    }), cachedQuota);

    expect(response.headers.get("x-codex-primary-used-percent")).toBe("44");
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("300");
    expect(response.headers.get("x-codex-primary-reset-at")).toBe("1786518429");
    expect(response.headers.get("x-codex-active-limit")).toBe("secondary");
    expect(response.headers.get("x-codex-secondary-used-percent")).toBe("12");
  });

  it("marks an exhausted cached secondary window", async () => {
    const response = await responseWithQuotaHeaders(new Headers(), {
      ...cachedQuota,
      secondary_rate_limit: {
        ...cachedQuota.secondary_rate_limit!,
        limit_reached: true,
      },
    });

    expect(response.headers.get("x-codex-rate-limit-reached-type")).toBe("secondary");
  });
});
