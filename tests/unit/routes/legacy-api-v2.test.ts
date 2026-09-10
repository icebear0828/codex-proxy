import { describe, expect, it } from "vitest";
import { createWebRoutes } from "@src/routes/web.js";

const pool = {
  getProxyApiKey: () => null,
} as never;

const usageStats = {} as never;

describe("legacy API v2 endpoints", () => {
  it("returns a migration response instead of an uninformative 404", async () => {
    const app = createWebRoutes(pool, usageStats);
    const response = await app.request("/api/v2/auth/login", { method: "POST" });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "legacy_api_removed",
      message: "The /api/v2 API was removed. Use the current API endpoints.",
    });
  });
});
