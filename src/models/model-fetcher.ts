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
const INITIAL_DELAY_MS = 5_000; // 5s after startup

let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _accountPool: AccountPool | null = null;
let _cookieJar: CookieJar | null = null;
let _proxyPool: ProxyPool | null = null;

/**
 * Fetch models from the Codex backend, one query per distinct plan type.
 * This discovers plan-specific model availability (e.g. Team has gpt-5.4, Free has gpt-oss-*).
 */
async function fetchModelsFromBackend(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool: ProxyPool | null,
): Promise<void> {
  if (!accountPool.isAuthenticated()) return; // silently skip when no accounts

  const planAccounts = accountPool.getDistinctPlanAccounts();
  if (planAccounts.length === 0) {
    console.warn("[ModelFetcher] No available accounts — skipping model fetch");
    return;
  }

  console.log(`[ModelFetcher] Fetching models for ${planAccounts.length} plan(s): ${planAccounts.map((p) => p.planType).join(", ")}`);

  const results = await Promise.allSettled(
    planAccounts.map(async (pa) => {
      try {
        const proxyUrl = proxyPool?.resolveProxyUrl(pa.entryId);
        const api = new CodexApi(pa.token, pa.accountId, cookieJar, pa.entryId, proxyUrl);
        const models = await api.getModels();
        if (models && models.length > 0) {
          applyBackendModelsForPlan(pa.planType, models);
          console.log(`[ModelFetcher] Plan "${pa.planType}": ${models.length} models`);
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
}

/**
 * Start the background model refresh loop.
 * - First fetch after a short delay (auth must be ready)
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

  // Initial fetch after short delay
  _refreshTimer = setTimeout(async () => {
    try {
      await fetchModelsFromBackend(accountPool, cookieJar, _proxyPool);
    } finally {
      scheduleNext(accountPool, cookieJar);
    }
  }, INITIAL_DELAY_MS);

  console.log("[ModelFetcher] Scheduled initial model fetch in 5s");
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
 * Trigger an immediate model refresh (e.g. after hot-reload).
 * No-op if startModelRefresh() hasn't been called yet.
 */
export function triggerImmediateRefresh(): void {
  if (_accountPool && _cookieJar) {
    fetchModelsFromBackend(_accountPool, _cookieJar, _proxyPool).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ModelFetcher] Immediate refresh failed: ${msg}`);
    });
  }
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
