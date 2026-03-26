/**
 * Usage Stats — time-series snapshot recording and aggregation.
 *
 * Records periodic snapshots of cumulative token usage across all accounts.
 * Snapshots are persisted to data/usage-history.json and pruned to 7 days.
 * Aggregation (delta computation, bucketing) happens on read.
 *
 * A "baseline" accumulates usage from accounts that have been removed or
 * replaced, so historical totals survive account pool resets.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { getDataDir } from "../paths.js";
import type { AccountPool } from "./account-pool.js";

// ── Types ──────────────────────────────────────────────────────────

export interface UsageSnapshot {
  timestamp: string; // ISO 8601
  totals: {
    input_tokens: number;
    output_tokens: number;
    request_count: number;
    active_accounts: number;
  };
}

export interface UsageBaseline {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

interface UsageHistoryFile {
  version: 1;
  snapshots: UsageSnapshot[];
  baseline?: UsageBaseline;
}

export interface UsageDataPoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_request_count: number;
  total_accounts: number;
  active_accounts: number;
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HISTORY_FILE = "usage-history.json";

// ── Persistence interface (injectable for testing) ─────────────────

export interface UsageStatsPersistence {
  load(): UsageHistoryFile;
  save(data: UsageHistoryFile): void;
}

export function createFsUsageStatsPersistence(): UsageStatsPersistence {
  function getFilePath(): string {
    return resolve(getDataDir(), HISTORY_FILE);
  }

  return {
    load(): UsageHistoryFile {
      try {
        const filePath = getFilePath();
        if (!existsSync(filePath)) return { version: 1, snapshots: [] };
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as UsageHistoryFile;
        if (!Array.isArray(data.snapshots)) return { version: 1, snapshots: [] };
        return data;
      } catch {
        return { version: 1, snapshots: [] };
      }
    },

    save(data: UsageHistoryFile): void {
      try {
        const filePath = getFilePath();
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmpFile = filePath + ".tmp";
        writeFileSync(tmpFile, JSON.stringify(data), "utf-8");
        renameSync(tmpFile, filePath);
      } catch (err) {
        console.error("[UsageStats] Failed to persist:", err instanceof Error ? err.message : err);
      }
    },
  };
}

// ── Store ──────────────────────────────────────────────────────────

export class UsageStatsStore {
  private persistence: UsageStatsPersistence;
  private snapshots: UsageSnapshot[];
  private baseline: UsageBaseline;

  constructor(persistence?: UsageStatsPersistence) {
    this.persistence = persistence ?? createFsUsageStatsPersistence();
    const loaded = this.persistence.load();
    this.snapshots = loaded.snapshots;
    this.baseline = loaded.baseline ?? { input_tokens: 0, output_tokens: 0, request_count: 0 };
  }

  /** Sum current live usage from all accounts in the pool. */
  private poolTotals(pool: AccountPool): { input_tokens: number; output_tokens: number; request_count: number; active_accounts: number; total_accounts: number } {
    const entries = pool.getAllEntries();
    let input_tokens = 0;
    let output_tokens = 0;
    let request_count = 0;
    let active_accounts = 0;

    for (const entry of entries) {
      input_tokens += entry.usage.input_tokens;
      output_tokens += entry.usage.output_tokens;
      request_count += entry.usage.request_count;
      if (entry.status === "active") active_accounts++;
    }

    return { input_tokens, output_tokens, request_count, active_accounts, total_accounts: entries.length };
  }

  /** Take a snapshot of current cumulative usage across all accounts. */
  recordSnapshot(pool: AccountPool): void {
    const live = this.poolTotals(pool);
    const now = new Date().toISOString();

    // Detect pool reset: if live totals dropped below previous snapshot,
    // the difference was lost usage from removed accounts — absorb into baseline.
    const lastSnapshot = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
    if (lastSnapshot) {
      const prevLive = {
        input_tokens: lastSnapshot.totals.input_tokens - this.baseline.input_tokens,
        output_tokens: lastSnapshot.totals.output_tokens - this.baseline.output_tokens,
        request_count: lastSnapshot.totals.request_count - this.baseline.request_count,
      };
      if (live.input_tokens < prevLive.input_tokens ||
          live.output_tokens < prevLive.output_tokens ||
          live.request_count < prevLive.request_count) {
        this.baseline = {
          input_tokens: this.baseline.input_tokens + Math.max(0, prevLive.input_tokens - live.input_tokens),
          output_tokens: this.baseline.output_tokens + Math.max(0, prevLive.output_tokens - live.output_tokens),
          request_count: this.baseline.request_count + Math.max(0, prevLive.request_count - live.request_count),
        };
      }
    }

    // Snapshot totals = baseline + live (monotonically increasing)
    this.snapshots.push({
      timestamp: now,
      totals: {
        input_tokens: this.baseline.input_tokens + live.input_tokens,
        output_tokens: this.baseline.output_tokens + live.output_tokens,
        request_count: this.baseline.request_count + live.request_count,
        active_accounts: live.active_accounts,
      },
    });

    // Prune old snapshots
    const cutoff = Date.now() - MAX_AGE_MS;
    this.snapshots = this.snapshots.filter(
      (s) => new Date(s.timestamp).getTime() >= cutoff,
    );

    this.persistence.save({ version: 1, snapshots: this.snapshots, baseline: this.baseline });
  }

  /** Get current cumulative summary (baseline + live pool data). */
  getSummary(pool: AccountPool): UsageSummary {
    const live = this.poolTotals(pool);

    return {
      total_input_tokens: this.baseline.input_tokens + live.input_tokens,
      total_output_tokens: this.baseline.output_tokens + live.output_tokens,
      total_request_count: this.baseline.request_count + live.request_count,
      total_accounts: live.total_accounts,
      active_accounts: live.active_accounts,
    };
  }

  /**
   * Get usage history as delta data points, aggregated by granularity.
   * @param hours - how many hours of history to return
   * @param granularity - "raw" | "hourly" | "daily"
   */
  getHistory(
    hours: number,
    granularity: "raw" | "hourly" | "daily",
  ): UsageDataPoint[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const filtered = this.snapshots.filter(
      (s) => new Date(s.timestamp).getTime() >= cutoff,
    );

    if (filtered.length < 2) return [];

    // Compute deltas between consecutive snapshots
    const deltas: UsageDataPoint[] = [];
    for (let i = 1; i < filtered.length; i++) {
      const prev = filtered[i - 1].totals;
      const curr = filtered[i].totals;
      deltas.push({
        timestamp: filtered[i].timestamp,
        input_tokens: Math.max(0, curr.input_tokens - prev.input_tokens),
        output_tokens: Math.max(0, curr.output_tokens - prev.output_tokens),
        request_count: Math.max(0, curr.request_count - prev.request_count),
      });
    }

    if (granularity === "raw") return deltas;

    // Bucket into time intervals
    const bucketMs = granularity === "hourly" ? 3600_000 : 86400_000;
    return bucketize(deltas, bucketMs);
  }

  /** Get raw snapshot count (for testing). */
  get snapshotCount(): number {
    return this.snapshots.length;
  }

  /** Get current baseline (for testing). */
  get currentBaseline(): UsageBaseline {
    return { ...this.baseline };
  }
}

function bucketize(deltas: UsageDataPoint[], bucketMs: number): UsageDataPoint[] {
  if (deltas.length === 0) return [];

  const buckets = new Map<number, UsageDataPoint>();

  for (const d of deltas) {
    const t = new Date(d.timestamp).getTime();
    const bucketKey = Math.floor(t / bucketMs) * bucketMs;

    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.input_tokens += d.input_tokens;
      existing.output_tokens += d.output_tokens;
      existing.request_count += d.request_count;
    } else {
      buckets.set(bucketKey, {
        timestamp: new Date(bucketKey).toISOString(),
        input_tokens: d.input_tokens,
        output_tokens: d.output_tokens,
        request_count: d.request_count,
      });
    }
  }

  return [...buckets.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
