import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "@src/middleware/cors.js";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("cors middleware", () => {
  it("allows loopback origins on API compatibility routes", async () => {
    const app = createApp();

    const res = await app.request("/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5173");
    expect(res.headers.get("Vary")).toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  });

  it("does not expose admin routes to loopback web origins", async () => {
    const app = createApp();

    const res = await app.request("/admin/settings", {
      headers: { Origin: "http://127.0.0.1:5173" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not satisfy admin preflight requests", async () => {
    const app = createApp();

    const res = await app.request("/admin/settings", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("rejects non-loopback origins on API routes", async () => {
    const app = createApp();

    const res = await app.request("/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
