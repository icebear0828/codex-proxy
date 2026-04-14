/**
 * Tests for UsageStatsStore — snapshot recording, delta computation, aggregation,
 * and baseline preservation across account pool resets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

import { UsageStatsStore, type UsageStatsPersistence, type UsageSnapshot, type UsageBaseline } from "@src/auth/usage-stats.js";
import type { AccountPool } from "@src/auth/account-pool.js";

function createMockPersistence(
  initial: UsageSnapshot[] = [],
  baseline?: UsageBaseline,
): UsageStatsPersistence & { saved: UsageSnapshot[]; savedBaseline?: UsageBaseline } {
  const store = {
    saved: initial,
    savedBaseline: baseline,
    load: () => ({ version: 1 as const, snapshots: [...initial], baseline }),
    save: vi.fn((data: { version: 1; snapshots: UsageSnapshot[]; baseline?: UsageBaseline }) => {
      store.saved = data.snapshots;
      store.savedBaseline = data.baseline;
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
    it("returns live totals from pool when no baseline", () => {
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

    it("includes baseline in summary totals", () => {
      persistence = createMockPersistence([], {
        input_tokens: 10000,
        output_tokens: 2000,
        request_count: 100,
      });
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 500, output_tokens: 50, request_count: 5 },
      ]);

      const summary = store.getSummary(pool);
      expect(summary.total_input_tokens).toBe(10500);
      expect(summary.total_output_tokens).toBe(2050);
      expect(summary.total_request_count).toBe(105);
    });
  });

  describe("baseline — pool reset detection", () => {
    it("absorbs lost usage into baseline when pool totals drop", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 10000, output_tokens: 2000, request_count: 100, active_accounts: 5 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 500, output_tokens: 50, request_count: 5 },
      ]);

      store.recordSnapshot(pool);

      expect(store.currentBaseline).toEqual({
        input_tokens: 9500,
        output_tokens: 1950,
        request_count: 95,
      });

      const lastSnapshot = persistence.saved[persistence.saved.length - 1];
      expect(lastSnapshot.totals.input_tokens).toBe(10000);
      expect(lastSnapshot.totals.output_tokens).toBe(2000);
      expect(lastSnapshot.totals.request_count).toBe(100);
    });

    it("accumulates baseline across multiple resets", () => {
      const now = Date.now();

      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 15000, output_tokens: 3000, request_count: 150, active_accounts: 3 },
        },
      ];
      const existingBaseline: UsageBaseline = {
        input_tokens: 5000,
        output_tokens: 1000,
        request_count: 50,
      };

      persistence = createMockPersistence(snapshots, existingBaseline);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 200, output_tokens: 20, request_count: 2 },
      ]);

      store.recordSnapshot(pool);

      expect(store.currentBaseline.input_tokens).toBe(14800);
      expect(store.currentBaseline.output_tokens).toBe(2980);
      expect(store.currentBaseline.request_count).toBe(148);
    });

    it("does not adjust baseline when pool totals increase normally", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 1000, output_tokens: 200, request_count: 10, active_accounts: 2 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 1500, output_tokens: 300, request_count: 15 },
      ]);

      store.recordSnapshot(pool);

      expect(store.currentBaseline).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      });
    });

    it("persists baseline to disk", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 3600_000).toISOString(),
          totals: { input_tokens: 5000, output_tokens: 500, request_count: 50, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 100, output_tokens: 10, request_count: 1 },
      ]);

      store.recordSnapshot(pool);

      expect(persistence.savedBaseline).toEqual({
        input_tokens: 4900,
        output_tokens: 490,
        request_count: 49,
      });
    });

    it("loads baseline from persisted data", () => {
      const baseline: UsageBaseline = {
        input_tokens: 50000,
        output_tokens: 10000,
        request_count: 500,
      };

      persistence = createMockPersistence([], baseline);
      store = new UsageStatsStore(persistence);

      expect(store.currentBaseline).toEqual(baseline);

      const pool = createMockPool([
        { status: "active", input_tokens: 100, output_tokens: 10, request_count: 1 },
      ]);
      const summary = store.getSummary(pool);
      expect(summary.total_input_tokens).toBe(50100);
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
      expect(hourly).toHaveLength(2);
      expect(hourly[0].input_tokens).toBe(100);
      expect(hourly[1].input_tokens).toBe(400);
    });

    it("filters by time range", () => {
      const now = Date.now();
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date(now - 48 * 3600_000).toISOString(),
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(now - 12 * 3600_000).toISOString(),
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
        {
          timestamp: new Date(now).toISOString(),
          totals: { input_tokens: 1000, output_tokens: 100, request_count: 10, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

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
          timestamp: new Date(now - 8 * 24 * 3600_000).toISOString(),
          totals: { input_tokens: 100, output_tokens: 10, request_count: 1, active_accounts: 1 },
        },
        {
          timestamp: new Date(now - 1 * 3600_000).toISOString(),
          totals: { input_tokens: 500, output_tokens: 50, request_count: 5, active_accounts: 1 },
        },
      ];

      persistence = createMockPersistence(old);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 1000, output_tokens: 100, request_count: 10 },
      ]);
      store.recordSnapshot(pool);

      expect(store.snapshotCount).toBe(2);
    });
  });

  describe("recoverBaseline", () => {
    it("recovers baseline from last snapshot when no baseline was persisted", () => {
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date().toISOString(),
          totals: { input_tokens: 10_000_000, output_tokens: 2_000_000, request_count: 5000, active_accounts: 15 },
        },
      ];
      // No baseline — simulates pre-PR#221 data
      persistence = createMockPersistence(snapshots);
      store = new UsageStatsStore(persistence);

      // Current pool has much less usage (accounts were replaced)
      const pool = createMockPool([
        { status: "active", input_tokens: 100_000, output_tokens: 2000, request_count: 50 },
      ]);

      store.recoverBaseline(pool);

      const summary = store.getSummary(pool);
      // Should recover the full historical totals
      expect(summary.total_input_tokens).toBe(10_000_000);
      expect(summary.total_output_tokens).toBe(2_000_000);
      expect(summary.total_request_count).toBe(5000);

      // Baseline should have been persisted
      expect(persistence.save).toHaveBeenCalled();
      expect(persistence.savedBaseline).toEqual({
        input_tokens: 9_900_000,
        output_tokens: 1_998_000,
        request_count: 4950,
      });
    });

    it("does not recover when baseline already exists", () => {
      const snapshots: UsageSnapshot[] = [
        {
          timestamp: new Date().toISOString(),
          totals: { input_tokens: 10_000_000, output_tokens: 2_000_000, request_count: 5000, active_accounts: 15 },
        },
      ];
      const baseline: UsageBaseline = { input_tokens: 5_000_000, output_tokens: 1_000_000, request_count: 2500 };
      persistence = createMockPersistence(snapshots, baseline);
      store = new UsageStatsStore(persistence);

      const pool = createMockPool([
        { status: "active", input_tokens: 100_000, output_tokens: 2000, request_count: 50 },
      ]);

      store.recoverBaseline(pool);

      // Baseline should remain unchanged
      const summary = store.getSummary(pool);
      expect(summary.total_input_tokens).toBe(5_100_000);
    });
  });
});
