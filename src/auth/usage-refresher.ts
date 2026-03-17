/**
 * Usage Refresher — background quota refresh for all accounts.
 *
 * - Periodically fetches official quota from Codex backend
 * - Caches quota on AccountEntry for fast dashboard reads
 * - Marks quota-exhausted accounts as rate_limited
 * - Evaluates warning thresholds and updates warning store
 * - Non-fatal: all errors log warnings but never crash the server
 */

import { CodexApi } from "../proxy/codex-api.js";
import { getConfig } from "../config.js";
import { jitter } from "../utils/jitter.js";
import { toQuota } from "./quota-utils.js";
import {
  evaluateThresholds,
  updateWarnings,
  type QuotaWarning,
} from "./quota-warnings.js";
import type { AccountPool } from "./account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";

const INITIAL_DELAY_MS = 3_000; // 3s after startup

let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _accountPool: AccountPool | null = null;
let _cookieJar: CookieJar | null = null;
let _proxyPool: ProxyPool | null = null;

async function fetchQuotaForAllAccounts(
  pool: AccountPool,
  cookieJar: CookieJar,
  proxyPool: ProxyPool | null,
): Promise<void> {
  if (!pool.isAuthenticated()) return;

  const entries = pool.getAllEntries().filter((e) => e.status === "active");
  if (entries.length === 0) return;

  const config = getConfig();
  const thresholds = config.quota.warning_thresholds;

  console.log(`[QuotaRefresh] Refreshing quota for ${entries.length} active account(s)`);

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const proxyUrl = proxyPool?.resolveProxyUrl(entry.id);
      const api = new CodexApi(entry.token, entry.accountId, cookieJar, entry.id, proxyUrl);
      const usage = await api.getUsage();
      const quota = toQuota(usage);

      // Cache quota on the account
      pool.updateCachedQuota(entry.id, quota);

      // Sync rate limit window
      const resetAt = usage.rate_limit.primary_window?.reset_at ?? null;
      const windowSec = usage.rate_limit.primary_window?.limit_window_seconds ?? null;
      pool.syncRateLimitWindow(entry.id, resetAt, windowSec);

      // Mark exhausted if limit reached (primary or secondary)
      if (config.quota.skip_exhausted) {
        const primaryExhausted = quota.rate_limit.limit_reached;
        const secondaryExhausted = quota.secondary_rate_limit?.limit_reached ?? false;
        if (primaryExhausted || secondaryExhausted) {
          const exhaustResetAt = primaryExhausted
            ? quota.rate_limit.reset_at
            : quota.secondary_rate_limit?.reset_at ?? null;
          pool.markQuotaExhausted(entry.id, exhaustResetAt);
          console.log(`[QuotaRefresh] Account ${entry.id} (${entry.email ?? "?"}) quota exhausted — marked rate_limited`);
        }
      }

      // Evaluate warning thresholds
      const warnings: QuotaWarning[] = [];
      const pw = evaluateThresholds(
        entry.id,
        entry.email,
        quota.rate_limit.used_percent,
        quota.rate_limit.reset_at,
        "primary",
        thresholds.primary,
      );
      if (pw) warnings.push(pw);

      const sw = evaluateThresholds(
        entry.id,
        entry.email,
        quota.secondary_rate_limit?.used_percent ?? null,
        quota.secondary_rate_limit?.reset_at ?? null,
        "secondary",
        thresholds.secondary,
      );
      if (sw) warnings.push(sw);

      updateWarnings(entry.id, warnings);
    }),
  );

  let succeeded = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      succeeded++;
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[QuotaRefresh] Account quota fetch failed: ${msg}`);
    }
  }

  console.log(`[QuotaRefresh] Done: ${succeeded}/${entries.length} succeeded`);
}

function scheduleNext(
  pool: AccountPool,
  cookieJar: CookieJar,
): void {
  const config = getConfig();
  const intervalMs = jitter(config.quota.refresh_interval_minutes * 60 * 1000, 0.15);
  _refreshTimer = setTimeout(async () => {
    try {
      await fetchQuotaForAllAccounts(pool, cookieJar, _proxyPool);
    } finally {
      scheduleNext(pool, cookieJar);
    }
  }, intervalMs);
}

/**
 * Start the background quota refresh loop.
 */
export function startQuotaRefresh(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool?: ProxyPool,
): void {
  _accountPool = accountPool;
  _cookieJar = cookieJar;
  _proxyPool = proxyPool ?? null;

  _refreshTimer = setTimeout(async () => {
    try {
      await fetchQuotaForAllAccounts(accountPool, cookieJar, _proxyPool);
    } finally {
      scheduleNext(accountPool, cookieJar);
    }
  }, INITIAL_DELAY_MS);

  const config = getConfig();
  console.log(`[QuotaRefresh] Scheduled initial quota refresh in 3s (interval: ${config.quota.refresh_interval_minutes}min)`);
}

/**
 * Stop the background refresh timer.
 */
export function stopQuotaRefresh(): void {
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
    console.log("[QuotaRefresh] Stopped quota refresh");
  }
}
