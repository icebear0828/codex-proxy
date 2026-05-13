import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildAccountExhaustionDetail,
  respondWithNoAccount,
  respondWithProxyError,
} from "@src/routes/shared/proxy-error-response.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

function createRequest(isStreaming: boolean): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "hello" }],
      stream: isStreaming,
    },
    model: "codex",
    isStreaming,
  };
}

describe("proxy error response helpers", () => {
  it("builds account exhaustion detail from inactive pool counts", () => {
    expect(buildAccountExhaustionDetail({
      total: 6,
      active: 0,
      rate_limited: 2,
      expired: 1,
      banned: 1,
      disabled: 0,
      quota_exhausted: 1,
      refreshing: 1,
    }, "Rate limited")).toBe(
      "All accounts exhausted (2 rate-limited, 1 expired, 1 banned, 1 quota-exhausted, 1 refreshing). Rate limited",
    );
  });

  it("formats non-streaming proxy errors with the route-specific 429 formatter", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(false);

    app.get("/error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 429,
      message: "All accounts exhausted",
      useFormat429: true,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "All accounts exhausted",
    });
    expect(fmt.format429).toHaveBeenCalledWith("All accounts exhausted");
    expect(fmt.formatError).not.toHaveBeenCalled();
  });

  it("formats streaming proxy errors as SSE when the adapter supports stream errors", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(true);

    app.get("/stream-error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 503,
      message: "No accounts",
    }));

    const res = await app.request("/stream-error");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(text).toContain("event: response.failed");
    expect(text).toContain("No accounts");
    expect(fmt.formatStreamError).toHaveBeenCalledWith(503, "No accounts");
  });

  it("preserves route-specific no-account JSON responses for non-streaming requests", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(false);

    app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt }));

    const res = await app.request("/no-account");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_account" });
    expect(fmt.formatNoAccount).toHaveBeenCalledOnce();
  });
});
