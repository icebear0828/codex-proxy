import { describe, expect, it } from "vitest";
import { createWebRoutes } from "@src/routes/web.js";

const pool = {
  getProxyApiKey: () => null,
} as never;

const usageStats = {} as never;

describe("legacy API v2 endpoints", () => {
  it("returns a migration response instead of an uninformative 404 for POST /api/v2/auth/login", async () => {
    const app = createWebRoutes(pool, usageStats);
    const response = await app.request("/api/v2/auth/login", { method: "POST" });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "legacy_api_removed",
      message: "The /api/v2 API was removed. Use the current API endpoints.",
    });
  });

  it("returns a migration response for GET /api/v2/auth/login", async () => {
    const app = createWebRoutes(pool, usageStats);
    const response = await app.request("/api/v2/auth/login", { method: "GET" });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "legacy_api_removed",
      message: "The /api/v2 API was removed. Use the current API endpoints.",
    });
  });

  it("returns a migration response for GET and POST /api/v2/app/version", async () => {
    const app = createWebRoutes(pool, usageStats);
    const getRes = await app.request("/api/v2/app/version", { method: "GET" });
    expect(getRes.status).toBe(410);
    await expect(getRes.json()).resolves.toEqual({
      error: "legacy_api_removed",
      message: "The /api/v2 API was removed. Use the current API endpoints.",
    });

    const postRes = await app.request("/api/v2/app/version", { method: "POST" });
    expect(postRes.status).toBe(410);
    await expect(postRes.json()).resolves.toEqual({
      error: "legacy_api_removed",
      message: "The /api/v2 API was removed. Use the current API endpoints.",
    });
  });
});
