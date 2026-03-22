/**
 * Tests for UsageStatsStore — snapshot recording, delta computation, aggregation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

import { UsageStatsStore, type UsageStatsPersistence, type UsageSnapshot } from "../usage-stats.js";
import type { AccountPool } from "../account-pool.js";

function createMockPersistence(initial: UsageSnapshot[] = []): UsageStatsPersistence & { saved: UsageSnapshot[] } {
  const store = {
    saved: initial,
    load: () => ({ version: 1 as const, snapshots: [...initial] }),
    save: vi.fn((data: { version: 1; snapshots: UsageSnapshot[] }) => {
      store.saved = data.snapshots;
    }),
  };
  return store;
}

function createMockPool(entries: Array<{
  status: string;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}>): AccountPool {
  return {
    getAllEntries: () =>
      entries.map((e, i) => ({
        id: `entry-${i}`,
        status: e.status,
        usage: {
          input_tokens: e.input_tokens,
          output_tokens: e.output_tokens,
          request_count: e.request_count,
        },
      })),
  } as unknown as AccountPool;
}

describe("UsageStatsStore", () => {
  let persistence: ReturnType<typeof createMockPersistence>;
  let store: UsageStatsStore;

  beforeEach(() => {
    persistence = createMockPersistence();
    store = new UsageStatsStore(persistence);
  });

  describe("recordSnapshot", () => {
    it("records cumulative totals from all accounts", () => {
      const pool = createMockPool([
        { status: "active", input_tokens: 1000, output_tokens: 200, request_count: 5 },
        { status: "active", input_tokens: 500, output_tokens: 100, request_count: 3 },
        { status: "expired", input_tokens: 300, output_tokens: 50, request_count: 2 },
      ]);

      store.recordSnapshot(pool);

      expect(store.snapshotCount).toBe(1);
      expect(persistence.save).toHaveBeenCalledTimes(1);

      const saved = persistence.saved;
      expect(saved).toHaveLength(1);
      expect(saved[0].totals).toEqual({
        input_tokens: 1800,
        output_tokens: 350,
        request_count: 10,
        active_accounts: 2,
      });
    });

    it("handles empty pool", () => {
      const pool = createMockPool([]);
      store.recordSnapshot(pool);

      expect(store.snapshotCount).toBe(1);
      expect(persistence.saved[0].totals).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
        active_accounts: 0,
      });
    });
  });

  describe("getSummary", () => {
    it("returns live totals from pool", () => {
      const pool = createMockPool([
        { status: "active", input_tokens: 1000, output_tokens: 200, request_count: 5 },
        { status: "disabled", input_tokens: 500, output_tokens: 100, request_count: 3 },
      ]);

      const summary = store.getSummary(pool);
      expect(summary).toEqual({
        total_input_tokens: 1500,
        total_output_tokens: 300,
        total_request_count: 8,
        total_accounts: 2,
        active_accounts: 1,
      });
    });
  });

  describe("getHistory", () => {
    it("returns empty for less than 2 snapshots", () => {
      expect(store.getHistory(24, "hourly")).toEqual([]);
    });

    it("computes deltas between consecutive snapshots", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 100, output_tokens: 20, request_count: 2, active_accounts: 1 },
        },
        {
          timestamp: new Date(now - 1800_000).toISOString(),
          totals: { input_tokens: 300, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
        {
          timestamp: new Date(now).toISOString(),
          totals: { input_tokens: 600, output_tokens: 100, request_count: 10, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const raw = store.getHistory(2, "raw");
      expect(raw).toHaveLength(2);
      expect(raw[0].input_tokens).toBe(200);
      expect(raw[0].output_tokens).toBe(30);
      expect(raw[0].request_count).toBe(3);
      expect(raw[1].input_tokens).toBe(300);
      expect(raw[1].output_tokens).toBe(50);
      expect(raw[1].request_count).toBe(5);
    });

    it("clamps negative deltas to zero (account removal)", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 1000, output_tokens: 200, request_count: 10, active_accounts: 2 },
        },
        {
          timestamp: new Date(now).toISOString(),
          totals: { input_tokens: 500, output_tokens: 100, request_count: 5, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const raw = store.getHistory(2, "raw");
      expect(raw).toHaveLength(1);
      expect(raw[0].input_tokens).toBe(0);
      expect(raw[0].output_tokens).toBe(0);
      expect(raw[0].request_count).toBe(0);
    });

    it("aggregates into hourly buckets", () => {
      const now = Date.now();
      const hourStart = Math.floor(now / 3600_000) * 3600_000;

      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(hourStart - 1800_000).toISOString(),
          totals: { input_tokens: 0, output_tokens: 0, request_count: 0, active_accounts: 1 },
        },
        {
          timestamp: new Date(hourStart - 900_000).toISOString(),
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(hourStart + 100_000).toISOString(),
          totals: { input_tokens: 300, output_tokens: 30, request_count: 3, active_accounts: 1 },
        },
        {
          timestamp: new Date(hourStart + 200_000).toISOString(),
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const hourly = store.getHistory(2, "hourly");
      // Two buckets: one before hourStart, one at/after hourStart
      expect(hourly).toHaveLength(2);

      // Previous hour bucket: delta 0→100 = 100
      expect(hourly[0].input_tokens).toBe(100);
      // Current hour bucket: delta 100→300 + 300→500 = 200 + 200 = 400
      expect(hourly[1].input_tokens).toBe(400);
    });

    it("filters by time range", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 48 * 3600_000).toISOString(), // 48h ago
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(now - 12 * 3600_000).toISOString(), // 12h ago
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
        {
          timestamp: new Date(now).toISOString(),
          totals: { input_tokens: 1000, output_tokens: 100, request_count: 10, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      // Only last 24h → only the last two snapshots qualify → 1 delta
      const raw = store.getHistory(24, "raw");
      expect(raw).toHaveLength(1);
      expect(raw[0].input_tokens).toBe(500);
    });
  });

  describe("retention", () => {
    it("prunes snapshots older than 7 days on record", () => {
      const now = Date.now();
      const old: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 8 * 24 * 3600_000).toISOString(), // 8 days ago
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(now - 1 * 3600_000).toISOString(), // 1h ago
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(old);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 1000, output_tokens: 100, request_count: 10 },
      ]);
      store.recordSnapshot(pool);

      // Old snapshot pruned, recent + new remain
      expect(store.snapshotCount).toBe(2);
    });
  });
});
