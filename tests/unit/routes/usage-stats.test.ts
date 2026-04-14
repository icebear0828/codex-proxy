/**
 * Tests for usage stats API routes.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

import { Hono } from "hono";
import { UsageStatsStore, type UsageStatsPersistence, type UsageSnapshot } from "@src/auth/usage-stats.js";
import { createUsageStatsRoutes } from "@src/routes/admin/usage-stats.js";
import type { AccountPool } from "@src/auth/account-pool.js";

function createMockPool(totals: { input_tokens: number; output_tokens: number; request_count: number }): AccountPool {
  return {
    getAllEntries: () => [
      {
        id: "e1",
        status: "active",
        usage: totals,
      },
    ],
  } as unknown as AccountPool;
}

function createStore(snapshots: UsageSnapshot[] = []): UsageStatsStore {
  const persistence: UsageStatsPersistence = {
    load: () => ({ version: 1, snapshots: [...snapshots] }),
    save: vi.fn(),
  };
  return new UsageStatsStore(persistence);
}

describe("usage stats routes", () => {
  describe("GET /admin/usage-stats/summary", () => {
    it("returns cumulative totals", async () => {
      const pool = createMockPool({ input_tokens: 5000, output_tokens: 1000, request_count: 20 });
      const store = createStore();
      const app = new Hono();
      app.route("/", createUsageStatsRoutes(pool, store));

      const res = await app.request("/admin/usage-stats/summary");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.total_input_tokens).toBe(5000);
      expect(body.total_output_tokens).toBe(1000);
      expect(body.total_request_count).toBe(20);
      expect(body.total_accounts).toBe(1);
      expect(body.active_accounts).toBe(1);
    });
  });

  describe("GET /admin/usage-stats/history", () => {
    it("returns empty data_points when no history", async () => {
      const pool = createMockPool({ input_tokens: 0, output_tokens: 0, request_count: 0 });
      const store = createStore();
      const app = new Hono();
      app.route("/", createUsageStatsRoutes(pool, store));

      const res = await app.request("/admin/usage-stats/history");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.granularity).toBe("hourly");
      expect(body.data_points).toEqual([]);
    });

    it("returns delta data points with raw granularity", async () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(now).toISOString(),
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
      ];

      const pool = createMockPool({ input_tokens: 500, output_tokens: 50, request_count: 5 });
      const store = createStore(snapshots);
      const app = new Hono();
      app.route("/", createUsageStatsRoutes(pool, store));

      const res = await app.request("/admin/usage-stats/history?granularity=raw&hours=2");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.granularity).toBe("raw");
      expect(body.data_points).toHaveLength(1);
      expect(body.data_points[0].input_tokens).toBe(400);
    });

    it("rejects invalid granularity", async () => {
      const pool = createMockPool({ input_tokens: 0, output_tokens: 0, request_count: 0 });
      const store = createStore();
      const app = new Hono();
      app.route("/", createUsageStatsRoutes(pool, store));

      const res = await app.request("/admin/usage-stats/history?granularity=yearly");
      expect(res.status).toBe(400);
    });
  });
});
