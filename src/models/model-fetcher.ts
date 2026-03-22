/**
 * Model Fetcher — background model list refresh from Codex backend.
 *
 * - Probes known endpoints to discover the models list
 * - Normalizes and merges into the model store
 * - Non-fatal: all errors log warnings but never crash the server
 */

import { CodexApi } from "../proxy/codex-api.js";
import { applyBackendModelsForPlan } from "./model-store.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { jitter } from "../utils/jitter.js";

const REFRESH_INTERVAL_HOURS = 1;
const INITIAL_DELAY_MS = 1_000; // 1s after startup (fast plan-map population for mixed-plan routing)
const RETRY_DELAY_MS = 10_000; // 10s retry when accounts aren't ready yet
const MAX_RETRIES = 12; // ~2 minutes of retries before falling back to hourly

let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _accountPool: AccountPool | null = null;
let _cookieJar: CookieJar | null = null;
let _proxyPool: ProxyPool | null = null;
let _hasFetchedOnce = false;

/**
 * Fetch models from the Codex backend, one query per distinct plan type.
 * Returns true if at least one plan's models were fetched successfully.
 */
async function fetchModelsFromBackend(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool: ProxyPool | null,
): Promise<boolean> {
  if (!accountPool.isAuthenticated()) return false;

  const planAccounts = accountPool.getDistinctPlanAccounts();
  if (planAccounts.length === 0) {
    console.warn("[ModelFetcher] No available accounts — skipping model fetch");
    return false;
  }

  console.log(`[ModelFetcher] Fetching models for ${planAccounts.length} plan(s): ${planAccounts.map((p) => p.planType).join(", ")}`);

  let anySuccess = false;
  const results = await Promise.allSettled(
    planAccounts.map(async (pa) => {
      try {
        const proxyUrl = proxyPool?.resolveProxyUrl(pa.entryId);
        const api = new CodexApi(pa.token, pa.accountId, cookieJar, pa.entryId, proxyUrl);
        const models = await api.getModels();
        if (models && models.length > 0) {
          applyBackendModelsForPlan(pa.planType, models);
          console.log(`[ModelFetcher] Plan "${pa.planType}": ${models.length} models`);
          anySuccess = true;
        } else {
          console.log(`[ModelFetcher] Plan "${pa.planType}": empty model list — keeping existing`);
        }
      } finally {
        accountPool.release(pa.entryId);
      }
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[ModelFetcher] Plan fetch failed: ${msg}`);
    }
  }

  return anySuccess;
}

/**
 * Start the background model refresh loop.
 * - First fetch after a short delay (auth must be ready)
 * - If accounts aren't ready, retry every 10s (up to ~2 min) before falling back to hourly
 * - Subsequent fetches every ~1 hour with jitter
 */
export function startModelRefresh(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool?: ProxyPool,
): void {
  _accountPool = accountPool;
  _cookieJar = cookieJar;
  _proxyPool = proxyPool ?? null;
  _hasFetchedOnce = false;

  // Initial fetch after short delay
  _refreshTimer = setTimeout(() => {
    attemptInitialFetch(accountPool, cookieJar, 0);
  }, INITIAL_DELAY_MS);

  console.log("[ModelFetcher] Scheduled initial model fetch in 1s");
}

/**
 * Attempt initial fetch with fast retry.
 * Accounts may still be refreshing tokens at startup (Electron race condition).
 * Retry every 10s until success or max retries, then fall back to hourly.
 */
function attemptInitialFetch(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  attempt: number,
): void {
  fetchModelsFromBackend(accountPool, cookieJar, _proxyPool)
    .then((success) => {
      if (success) {
        _hasFetchedOnce = true;
        scheduleNext(accountPool, cookieJar);
      } else if (attempt < MAX_RETRIES) {
        console.log(`[ModelFetcher] Accounts not ready, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
        _refreshTimer = setTimeout(() => {
          attemptInitialFetch(accountPool, cookieJar, attempt + 1);
        }, RETRY_DELAY_MS);
      } else {
        console.warn("[ModelFetcher] Max retries reached, falling back to hourly refresh");
        scheduleNext(accountPool, cookieJar);
      }
    })
    .catch(() => {
      scheduleNext(accountPool, cookieJar);
    });
}

function scheduleNext(
  accountPool: AccountPool,
  cookieJar: CookieJar,
): void {
  const intervalMs = jitter(REFRESH_INTERVAL_HOURS * 3600 * 1000, 0.15);
  _refreshTimer = setTimeout(async () => {
    try {
      await fetchModelsFromBackend(accountPool, cookieJar, _proxyPool);
    } finally {
      scheduleNext(accountPool, cookieJar);
    }
  }, intervalMs);
}

/**
 * Trigger an immediate model refresh (e.g. after hot-reload or account login).
 * No-op if startModelRefresh() hasn't been called yet.
 */
export function triggerImmediateRefresh(): void {
  if (_accountPool && _cookieJar) {
    fetchModelsFromBackend(_accountPool, _cookieJar, _proxyPool)
      .then((success) => {
        if (success) _hasFetchedOnce = true;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ModelFetcher] Immediate refresh failed: ${msg}`);
      });
  }
}

/** Whether at least one successful backend fetch has completed. */
export function hasFetchedModels(): boolean {
  return _hasFetchedOnce;
}

/**
 * Stop the background refresh timer.
 */
export function stopModelRefresh(): void {
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
    console.log("[ModelFetcher] Stopped model refresh");
  }
}
