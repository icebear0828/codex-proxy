/**
 * UsageRefresher — background quota refresh for all accounts.
 *
 * Phase 8b: converted from module-level singletons to class.
 * Free function wrappers preserve backward compatibility for 3 importers.
 */

import { CodexApi } from "../proxy/codex-api.js";
import { getConfig } from "../config.js";
import { jitter } from "../utils/jitter.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { toQuota } from "./quota-utils.js";
import {
  evaluateThresholds,
  updateWarnings,
  type QuotaWarning,
} from "./quota-warnings.js";
import type { AccountPool } from "./account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { UsageStatsStore } from "./usage-stats.js";

import { isBanError, isTokenInvalidError } from "../proxy/error-classification.js";

const INITIAL_DELAY_MS = 3_000;

export class UsageRefresher {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pool: AccountPool;
  private cookieJar: CookieJar;
  private proxyPool: ProxyPool | null;
  private usageStats: UsageStatsStore | null;

  constructor(
    pool: AccountPool,
    cookieJar: CookieJar,
    proxyPool: ProxyPool | null,
    usageStats: UsageStatsStore | null,
  ) {
    this.pool = pool;
    this.cookieJar = cookieJar;
    this.proxyPool = proxyPool;
    this.usageStats = usageStats;
  }

  start(): void {
    this.stopped = false;
    const config = getConfig();

    if (config.quota.refresh_interval_minutes === 0) {
      console.log("[QuotaRefresh] Auto-refresh disabled (refresh_interval_minutes = 0)");
      return;
    }

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshAll();
      } finally {
        if (!this.stopped) this.scheduleNext();
      }
    }, INITIAL_DELAY_MS);

    console.log(`[QuotaRefresh] Scheduled initial quota refresh in 3s (interval: ${config.quota.refresh_interval_minutes}min)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      console.log("[QuotaRefresh] Stopped quota refresh");
    }
  }

  private async refreshAll(): Promise<void> {
    const pool = this.pool;
    const cookieJar = this.cookieJar;
    const proxyPool = this.proxyPool;

    if (!pool.isAuthenticated()) return;

    const entries = pool.getAllEntries().filter(
      (e) => e.status === "active" || e.status === "rate_limited" || e.status === "banned",
    );
    if (entries.length === 0) return;

    const config = getConfig();
    const thresholds = config.quota.warning_thresholds;

    console.log(`[QuotaRefresh] Refreshing quota for ${entries.length} active/rate-limited/banned account(s)`);

    const results = await mapWithConcurrency(
      entries,
      async (entry) => {
        const proxyUrl = proxyPool?.resolveProxyUrl(entry.id);
        const api = new CodexApi(entry.token, entry.accountId, cookieJar, entry.id, proxyUrl);
        const usage = await api.getUsage();
        const quota = toQuota(usage);

        if (entry.status === "banned") {
          pool.markStatus(entry.id, "active");
          console.log(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) unbanned — quota fetch succeeded`);
        }

        pool.updateCachedQuota(entry.id, quota);

        const resetAt = usage.rate_limit.primary_window?.reset_at ?? null;
        const windowSec = usage.rate_limit.primary_window?.limit_window_seconds ?? null;
        pool.syncRateLimitWindow(entry.id, resetAt, windowSec);

        if (config.quota.skip_exhausted) {
          const primaryExhausted = quota.rate_limit.limit_reached;
          const secondaryExhausted = quota.secondary_rate_limit?.limit_reached ?? false;
          if (primaryExhausted || secondaryExhausted) {
            const exhaustResetAt = primaryExhausted
              ? quota.rate_limit.reset_at
              : quota.secondary_rate_limit?.reset_at ?? null;
            pool.markQuotaExhausted(entry.id, exhaustResetAt);
            console.log(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) quota exhausted — marked rate_limited`);
          } else if (entry.status === "rate_limited") {
            pool.clearRateLimit(entry.id);
            console.log(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) quota recovered — marked active`);
          }
        }

        const warnings: QuotaWarning[] = [];
        const pw = evaluateThresholds(
          entry.id, entry.email,
          quota.rate_limit.used_percent, quota.rate_limit.reset_at,
          "primary", thresholds.primary,
        );
        if (pw) warnings.push(pw);

        const sw = evaluateThresholds(
          entry.id, entry.email,
          quota.secondary_rate_limit?.used_percent ?? null,
          quota.secondary_rate_limit?.reset_at ?? null,
          "secondary", thresholds.secondary,
        );
        if (sw) warnings.push(sw);

        updateWarnings(entry.id, warnings);
      },
      config.quota.concurrency,
    );

    let succeeded = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        succeeded++;
      } else {
        const entry = entries[i];
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);

        if (isBanError(r.reason)) {
          pool.markStatus(entry.id, "banned");
          console.warn(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) banned — 403 from upstream`);
        } else if (isTokenInvalidError(r.reason)) {
          pool.markStatus(entry.id, "expired");
          console.warn(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) token invalidated — 401 from upstream`);
        } else {
          console.warn(`[QuotaRefresh] Account ${entry.id} quota fetch failed: ${msg}`);
        }
      }
    }

    console.log(`[QuotaRefresh] Done: ${succeeded}/${entries.length} succeeded`);

    if (this.usageStats) {
      try {
        this.usageStats.recordSnapshot(pool);
      } catch (err) {
        console.warn("[QuotaRefresh] Failed to record usage snapshot:", err instanceof Error ? err.message : err);
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const config = getConfig();
    const intervalMs = jitter(config.quota.refresh_interval_minutes * 60 * 1000, 0.15);
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshAll();
      } finally {
        if (!this.stopped) this.scheduleNext();
      }
    }, intervalMs);
  }
}

// ── Free function wrappers (backward compatibility) ──────────────────

let _instance: UsageRefresher | null = null;

export function startQuotaRefresh(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool?: ProxyPool,
  usageStats?: UsageStatsStore,
): void {
  _instance?.stop();
  _instance = new UsageRefresher(accountPool, cookieJar, proxyPool ?? null, usageStats ?? null);
  _instance.start();
}

export function stopQuotaRefresh(): void {
  _instance?.stop();
  _instance = null;
}
