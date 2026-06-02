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

const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum gap per account

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

  start(): void {
    this.stopped = false;
    const config = getConfig();
    if (config.auth.refresh_enabled === false) {
      console.log("[ActiveQuotaRefresher] Auto-refresh disabled in config.");
      return;
    }

    this.scheduleNext(DEFAULT_TICK_INTERVAL_MS);
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
        // Condition 2: Account was locally reset offline and requires verification.
        const isLocked = entry.cachedQuota?.rate_limit.limit_reached === true;
        const isDirty = entry.quotaVerifyRequired === true;

        if (!isLocked && !isDirty) continue;

        // Anti-abuse: ensure minimum time gap between active refreshes per account.
        const lastRefresh = this.lastRefreshedAt.get(entry.id) ?? 0;
        if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) continue;

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
          this.pool.updateCachedQuota(entry.id, quota);
        } catch (err) {
          console.warn(`[ActiveQuotaRefresher] Failed to fetch quota for account ${entry.id}:`, err instanceof Error ? err.message : err);
        }

        // Slight staggering delay between accounts to prevent simultaneous burst.
        await new Promise((resolve) => setTimeout(resolve, jitter(3000, 0.2)));
      }
    } catch (err) {
      console.warn("[ActiveQuotaRefresher] Error during tick:", err instanceof Error ? err.message : err);
    } finally {
      this.scheduleNext(DEFAULT_TICK_INTERVAL_MS);
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
