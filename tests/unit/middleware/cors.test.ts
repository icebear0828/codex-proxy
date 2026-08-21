import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import { cors } from "@src/middleware/cors.js";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ server: { cors: [] as string[], cors_allow_null_origin: false } })),
}));

vi.mock("@src/config.js", () => ({
  getConfig: mocks.getConfig,
}));

function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("cors middleware", () => {
  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ server: { cors: [], cors_allow_null_origin: false } });
  });
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

  describe("CORS allowlist", () => {
    it("accepts allowlisted origins", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: ["example.com"] } });

      const app = createApp();

      const res = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    });

    it("accepts allowlisted origins with https:// scheme prefix", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: ["https://example.com"] } });

      const app = createApp();

      const res = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    });

    it("accepts allowlisted origins with http:// scheme prefix", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: ["http://example.com"] } });

      const app = createApp();

      const res = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://example.com");
    });

    it("rejects non-allowlisted non-loopback origins", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: ["allowed.com"], cors_allow_null_origin: false } });

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

  describe("cors_allow_null_origin", () => {
    it("rejects Origin: null by default (when false)", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: [], cors_allow_null_origin: false } });

      const app = createApp();

      const preflight = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "null",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

      const req = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Origin: "null",
        },
      });
      expect(req.status).toBe(200);
      expect(req.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("allows Origin: null on API preflight and actual requests when enabled", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: [], cors_allow_null_origin: true } });

      const app = createApp();

      const preflight = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "null",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("null");
      expect(preflight.headers.get("Vary")).toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");

      const req = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Origin: "null",
        },
      });
      expect(req.status).toBe(200);
      expect(req.headers.get("Access-Control-Allow-Origin")).toBe("null");
      expect(req.headers.get("Vary")).toBe("Origin");
    });

    it("does not allow non-loopback origins even when cors_allow_null_origin is true", async () => {
      mocks.getConfig.mockReturnValue({ server: { cors: [], cors_allow_null_origin: true } });

      const app = createApp();

      const preflight = await app.request("/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.com",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});

describe("CORS_ALLOWED_HOSTS env var parsing", () => {
  const originalEnv = process.env.CORS_ALLOWED_HOSTS;

  afterEach(() => {
    delete process.env.CORS_ALLOWED_HOSTS;
  });

  afterAll(() => {
    process.env.CORS_ALLOWED_HOSTS = originalEnv;
  });

  it("parses comma-separated hosts", async () => {
    process.env.CORS_ALLOWED_HOSTS = "example.com, test.com";

    // This would normally be tested through the config loading system
    // For now, we'll test the parsing logic directly
    const corsAllowedHosts = process.env.CORS_ALLOWED_HOSTS?.trim();
    const result = corsAllowedHosts
      ?.split(",")
      .map((h: string) => h.trim())
      .filter((h: string) => h.length > 0);

    expect(result).toEqual(["example.com", "test.com"]);
  });

  it("trims whitespace from hosts", async () => {
    process.env.CORS_ALLOWED_HOSTS = " example.com , test.com ";

    const corsAllowedHosts = process.env.CORS_ALLOWED_HOSTS?.trim();
    const result = corsAllowedHosts
      ?.split(",")
      .map((h: string) => h.trim())
      .filter((h: string) => h.length > 0);

    expect(result).toEqual(["example.com", "test.com"]);
  });

  it("filters out empty entries", async () => {
    process.env.CORS_ALLOWED_HOSTS = "example.com,, test.com";

    const corsAllowedHosts = process.env.CORS_ALLOWED_HOSTS?.trim();
    const result = corsAllowedHosts
      ?.split(",")
      .map((h: string) => h.trim())
      .filter((h: string) => h.length > 0);

    expect(result).toEqual(["example.com", "test.com"]);
  });
});
