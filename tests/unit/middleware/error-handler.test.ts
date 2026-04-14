/**
 * Tests for error-handler middleware.
 * Uses Hono app.onError() + app.request() to route thrown errors
 * through errorHandler, matching real Hono error handling behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "@src/middleware/error-handler.js";

function createApp(throwFn: () => never): Hono {
  const app = new Hono();
  // Use Hono's onError to route thrown errors through our errorHandler.
  // errorHandler(c, next) catches the error from `await next()` and returns
  // the appropriate JSON response via `c.json()`.
  app.onError((err, c) =>
    errorHandler(c, async () => { throw err; }) as unknown as Response,
  );
  app.all("/*", () => {
    throwFn();
  });
  return app;
}

// Suppress console.error noise in tests
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── OpenAI-format errors (default) ───────────────────────────────

describe("errorHandler — OpenAI format (default routes)", () => {
  it("returns 500 with server_error for generic Error", async () => {
    const app = createApp(() => { throw new Error("something broke"); });
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("something broke");
    expect(body.error.code).toBe("internal_error");
  });

  it("returns 401 for status=401 error", async () => {
    const app = createApp(() => {
      const err = new Error("unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("returns 429 for status=429 error", async () => {
    const app = createApp(() => {
      const err = new Error("rate limited") as Error & { status: number };
      err.status = 429;
      throw err;
    });
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("returns 502 for status>=500 upstream errors", async () => {
    const app = createApp(() => {
      const err = new Error("upstream timeout") as Error & { status: number };
      err.status = 503;
      throw err;
    });
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("Upstream server error");
  });

  it("returns 400 for malformed JSON SyntaxError", async () => {
    const app = createApp(() => {
      throw new SyntaxError("Unexpected token in JSON at position 0");
    });
    const res = await app.request("/anything");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.message).toContain("Malformed JSON");
  });

  it("returns 500 with error message from Error object", async () => {
    const app = createApp(() => { throw new Error("custom failure reason"); });
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("custom failure reason");
    expect(body.error.param).toBeNull();
  });
});

// ── Anthropic-format errors ──────────────────────────────────────

describe("errorHandler — Anthropic format (/v1/messages)", () => {
  it("returns Anthropic error shape for /v1/messages", async () => {
    const app = createApp(() => { throw new Error("something broke"); });
    const res = await app.request("/v1/messages");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("something broke");
  });

  it("returns 401 authentication_error for /v1/messages", async () => {
    const app = createApp(() => {
      const err = new Error("bad token") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const res = await app.request("/v1/messages");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 429 rate_limit_error for /v1/messages", async () => {
    const app = createApp(() => {
      const err = new Error("rate limited") as Error & { status: number };
      err.status = 429;
      throw err;
    });
    const res = await app.request("/v1/messages");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("returns 502 api_error for /v1/messages upstream error", async () => {
    const app = createApp(() => {
      const err = new Error("upstream") as Error & { status: number };
      err.status = 503;
      throw err;
    });
    const res = await app.request("/v1/messages");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.type).toBe("api_error");
  });
});

// ── Gemini-format errors ─────────────────────────────────────────

describe("errorHandler — Gemini format (/v1beta/)", () => {
  it("returns Gemini error shape for /v1beta/ routes", async () => {
    const app = createApp(() => { throw new Error("something broke"); });
    const res = await app.request("/v1beta/test");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe(500);
    expect(body.error.status).toBe("INTERNAL");
    expect(body.error.message).toBe("something broke");
  });

  it("maps 429 to RESOURCE_EXHAUSTED for Gemini", async () => {
    const app = createApp(() => {
      const err = new Error("rate limited") as Error & { status: number };
      err.status = 429;
      throw err;
    });
    const res = await app.request("/v1beta/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
  });

  it("maps 401 to UNAUTHENTICATED for Gemini", async () => {
    const app = createApp(() => {
      const err = new Error("bad key") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const res = await app.request("/v1beta/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.status).toBe("UNAUTHENTICATED");
  });
});

// ── Passthrough ──────────────────────────────────────────────────

describe("errorHandler — passthrough", () => {
  it("passes through successful responses without modification", async () => {
    const app = new Hono();
    app.use("*", errorHandler);
    app.get("/health", (c) => c.json({ status: "ok" }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
