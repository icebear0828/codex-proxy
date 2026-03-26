/**
 * SnapshotTimer — periodically records usage stats snapshots for the dashboard.
 *
 * Previously this module also polled GET /codex/usage for each account.
 * That active polling was removed because quota data is now collected passively
 * from response headers on every proxied request (see proxy-handler.ts +
 * rate-limit-headers.ts).  Only the local snapshot recording remains.
 */

import { getConfig } from "../config.js";
import { jitter } from "../utils/jitter.js";
import type { AccountPool } from "./account-pool.js";
import type { UsageStatsStore } from "./usage-stats.js";

const INITIAL_DELAY_MS = 3_000;

export class SnapshotTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pool: AccountPool;
  private usageStats: UsageStatsStore;

  constructor(pool: AccountPool, usageStats: UsageStatsStore) {
    this.pool = pool;
    this.usageStats = usageStats;
  }

  start(): void {
    this.stopped = false;
    const config = getConfig();
    const intervalMin = config.quota.refresh_interval_minutes;

    if (intervalMin === 0) {
      console.log("[SnapshotTimer] Disabled (refresh_interval_minutes = 0)");
      return;
    }

    this.timer = setTimeout(() => {
      this.tick();
    }, INITIAL_DELAY_MS);

    console.log(`[SnapshotTimer] Recording snapshots every ${intervalMin}min`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    try {
      this.usageStats.recordSnapshot(this.pool);
    } catch (err) {
      console.warn("[SnapshotTimer] Failed to record snapshot:", err instanceof Error ? err.message : err);
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const config = getConfig();
    const intervalMs = jitter(config.quota.refresh_interval_minutes * 60 * 1000, 0.15);
    this.timer = setTimeout(() => this.tick(), intervalMs);
  }
}

// ── Free function wrappers (backward compatibility) ──────────────────

let _instance: SnapshotTimer | null = null;

export function startQuotaRefresh(
  accountPool: AccountPool,
  usageStats?: UsageStatsStore,
): void {
  _instance?.stop();
  if (!usageStats) return;
  _instance = new SnapshotTimer(accountPool, usageStats);
  _instance.start();
}

export function stopQuotaRefresh(): void {
  _instance?.stop();
  _instance = null;
}
