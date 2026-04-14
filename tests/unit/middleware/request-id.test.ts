/**
 * Tests for request-id middleware.
 * Uses Hono app.request() to verify header injection and context storage.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", requestId);
  app.get("/test", (c) => {
    return c.json({ requestId: c.get("requestId") });
  });
  return app;
}

describe("requestId middleware", () => {
  it("generates a request ID and sets X-Request-Id header", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id!.length).toBe(8);
  });

  it("stores generated ID in context via c.set()", async () => {
    const app = createApp();
    const res = await app.request("/test");
    const body = await res.json();
    const headerId = res.headers.get("X-Request-Id");
    expect(body.requestId).toBe(headerId);
  });

  it("uses client-provided X-Request-Id header instead of generating one", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { "x-request-id": "custom-id-123" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("custom-id-123");
    const body = await res.json();
    expect(body.requestId).toBe("custom-id-123");
  });

  it("generates unique IDs for different requests", async () => {
    const app = createApp();
    const res1 = await app.request("/test");
    const res2 = await app.request("/test");
    const id1 = res1.headers.get("X-Request-Id");
    const id2 = res2.headers.get("X-Request-Id");
    expect(id1).not.toBe(id2);
  });
});
