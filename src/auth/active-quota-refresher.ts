/**
 * ActiveQuotaRefresher — active background quota synchronizer.
 * Periodically scans for accounts that are deadlocked (limit_reached) or
 * dirty (quotaVerifyRequired) and actively fetches their fresh quota from upstream.
 */

import { getConfig } from "../config.js";
import { CodexApi } from "../proxy/codex-api.js";
import { toQuota } from "./quota-utils.js";
import { jitter } from "../utils/jitter.js";
import type { AccountPool } from "./account-pool.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { CodexQuota } from "./types.js";

const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum gap per account

/**
 * Resolve the scan tick interval and the per-account minimum refresh gap from
 * `quota.refresh_interval_minutes`. When unset (undefined) or 0, the historical
 * defaults (15 min tick / 30 min min-gap) are used. Exported for unit testing;
 * production wiring is `quota.refresh_interval_minutes === 0` in default.yaml.
 */
export function resolveRefreshIntervals(
  minutes: number | undefined | null,
): { tickMs: number; minGapMs: number } {
  const configuredMs = typeof minutes === "number" && minutes > 0 ? minutes * 60_000 : null;
  return {
    tickMs: configuredMs ?? DEFAULT_TICK_INTERVAL_MS,
    minGapMs: configuredMs ?? MIN_REFRESH_INTERVAL_MS,
  };
}

export class ActiveQuotaRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pool: AccountPool;
  private cookieJar?: CookieJar;
  private proxyPool?: ProxyPool | null;
  private lastRefreshedAt: Map<string, number> = new Map();

  constructor(
    pool: AccountPool,
    options?: {
      cookieJar?: CookieJar;
      proxyPool?: ProxyPool | null;
    },
  ) {
    this.pool = pool;
    this.cookieJar = options?.cookieJar;
    this.proxyPool = options?.proxyPool;
  }

  /**
   * Resolve the scan tick interval and the per-account minimum refresh gap from
   * `quota.refresh_interval_minutes`. When unset (or 0) the historical defaults
   * (15 min tick / 30 min gap) are used.
   */
  private resolveIntervals(): { tickMs: number; minGapMs: number } {
    return resolveRefreshIntervals(getConfig().quota?.refresh_interval_minutes ?? null);
  }

  start(): void {
    this.stopped = false;
    const config = getConfig();
    if (config.auth.refresh_enabled === false) {
      console.log("[ActiveQuotaRefresher] Auto-refresh disabled in config.");
      return;
    }

    this.scheduleNext(this.resolveIntervals().tickMs);
    console.log("[ActiveQuotaRefresher] Active Quota Refresher started");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      const entries = this.pool.getAllEntries();

      for (const entry of entries) {
        if (entry.status !== "active") continue;

        // Condition 1: Account is marked as limit_reached (locked in black-hole).
        // Condition 1b: Fix #730 — used_percent>=100 even if limit_reached not yet
        //   set; upstream may have lifted the limit but passive header path sets
        //   limit_reached=true from used_percent>=100, so this is already covered.
        //   Also proactively refresh when any per-model bucket is locked (Bug 3).
        // Condition 2: Account was locally reset offline and requires verification.
        const primaryLocked = entry.cachedQuota?.rate_limit.limit_reached === true;
        const primaryExhausted = (entry.cachedQuota?.rate_limit.used_percent ?? 0) >= 100;
        // Fix #730 Bug 3: check all rate_limits_by_limit_id buckets
        const bucketLocked =
          entry.cachedQuota?.rate_limits_by_limit_id != null &&
          Object.values(entry.cachedQuota.rate_limits_by_limit_id).some(
            (l) => l.limit_reached === true,
          );
        const isLocked = primaryLocked || primaryExhausted || bucketLocked;
        const isDirty = entry.quotaVerifyRequired === true;

        if (!isLocked && !isDirty) continue;

        // Anti-abuse: ensure minimum time gap between active refreshes per account.
        const lastRefresh = this.lastRefreshedAt.get(entry.id) ?? 0;
        if (now - lastRefresh < this.resolveIntervals().minGapMs) continue;

        console.log(`[ActiveQuotaRefresher] Actively refreshing quota for ${entry.id} (${entry.email ?? "?"}) (locked=${isLocked}, dirty=${isDirty})`);
        
        // Mark timestamp to enforce throttle.
        this.lastRefreshedAt.set(entry.id, now);

        try {
          const proxyUrl = this.proxyPool?.resolveProxyUrl(entry.id);
          const usage = await new CodexApi(
            entry.token,
            entry.accountId,
            this.cookieJar,
            entry.id,
            proxyUrl,
          ).getUsage();

          const quota = toQuota(usage);
          this.pool.updateCachedQuota(entry.id, preserveLearnedLocks(entry.cachedQuota, quota));
        } catch (err) {
          console.warn(`[ActiveQuotaRefresher] Failed to fetch quota for account ${entry.id}:`, err instanceof Error ? err.message : err);
        }

        // Slight staggering delay between accounts to prevent simultaneous burst.
        await new Promise((resolve) => setTimeout(resolve, jitter(3000, 0.2)));
      }
    } catch (err) {
      console.warn("[ActiveQuotaRefresher] Error during tick:", err instanceof Error ? err.message : err);
    } finally {
      this.scheduleNext(this.resolveIntervals().tickMs);
    }
  }

  private scheduleNext(baseIntervalMs: number): void {
    if (this.stopped) return;
    const intervalMs = jitter(baseIntervalMs, 0.2); // Apply random jitter
    this.timer = setTimeout(() => {
      void this.tick();
    }, intervalMs);
  }
}

/**
 * Merge a freshly fetched quota with any 429-learned locks already cached on
 * the entry. The `/usage` endpoint is sometimes inconsistent with the
 * enforcement layer (especially for free-plan accounts): it can report an
 * account as available while `/codex/responses` still answers 429. Without
 * this guard, such an optimistic answer would silently clear the lock, the
 * account re-enters rotation, and the next real request wastes a full payload
 * upload + failover latency before being 429'd again.
 *
 * A learned lock whose `reset_at` is still in the future is kept until it
 * passes; once the window resets the fresh quota applies normally and the
 * account auto-unlocks. (Primary, secondary, code_review and per-model buckets
 * are all protected.)
 */
export function preserveLearnedLocks(
  existing: CodexQuota | null | undefined,
  fresh: CodexQuota,
): CodexQuota {
  const nowSec = Date.now() / 1000;
  const isFutureLock = (
    cur: { limit_reached?: boolean; reset_at?: number | null } | null | undefined,
  ): boolean => cur?.limit_reached === true && cur.reset_at != null && cur.reset_at > nowSec;

  const merged: CodexQuota = { ...fresh };

  if (fresh.credits == null && existing?.credits != null) {
    merged.credits = existing.credits;
  }
  if (fresh.reset_credits_available == null && existing?.reset_credits_available != null) {
    merged.reset_credits_available = existing.reset_credits_available;
  }

  if (isFutureLock(existing?.rate_limit) && !fresh.rate_limit.limit_reached) {
    merged.rate_limit = {
      ...fresh.rate_limit,
      allowed: false,
      limit_reached: true,
      used_percent: Math.max(fresh.rate_limit.used_percent ?? 0, 100),
      reset_at: existing!.rate_limit.reset_at,
    };
  }

  const secondaryExisting = existing?.secondary_rate_limit;
  if (isFutureLock(secondaryExisting) && !merged.secondary_rate_limit?.limit_reached) {
    const freshWindow = merged.secondary_rate_limit;
    merged.secondary_rate_limit = {
      used_percent: freshWindow?.used_percent ?? 100,
      remaining_percent: freshWindow?.remaining_percent,
      reset_at: secondaryExisting!.reset_at,
      limit_window_seconds: freshWindow?.limit_window_seconds ?? secondaryExisting!.limit_window_seconds,
      limit_reached: true,
    };
  }

  const reviewExisting = existing?.code_review_rate_limit;
  if (isFutureLock(reviewExisting) && !merged.code_review_rate_limit?.limit_reached) {
    const freshWindow = merged.code_review_rate_limit;
    merged.code_review_rate_limit = {
      allowed: freshWindow?.allowed ?? false,
      limit_reached: true,
      used_percent: freshWindow?.used_percent ?? 100,
      remaining_percent: freshWindow?.remaining_percent,
      reset_at: reviewExisting!.reset_at,
      limit_window_seconds: freshWindow?.limit_window_seconds ?? reviewExisting!.limit_window_seconds,
    };
  }

  if (existing?.rate_limits_by_limit_id) {
    const freshBuckets = merged.rate_limits_by_limit_id ?? {};
    merged.rate_limits_by_limit_id = { ...freshBuckets };
    for (const [limitId, cur] of Object.entries(existing.rate_limits_by_limit_id)) {
      if (isFutureLock(cur) && !freshBuckets[limitId]?.limit_reached) {
        const freshBucket = freshBuckets[limitId];
        merged.rate_limits_by_limit_id[limitId] = {
          limit_id: freshBucket?.limit_id ?? cur.limit_id,
          limit_name: freshBucket?.limit_name ?? cur.limit_name,
          allowed: freshBucket?.allowed ?? false,
          limit_reached: true,
          used_percent: freshBucket?.used_percent ?? 100,
          remaining_percent: freshBucket?.remaining_percent,
          reset_at: cur.reset_at,
          limit_window_seconds: freshBucket?.limit_window_seconds ?? cur.limit_window_seconds,
          secondary_rate_limit: freshBucket?.secondary_rate_limit ?? cur.secondary_rate_limit,
        };
      }
    }
  }

  return merged;
}
