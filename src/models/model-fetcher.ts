/**
 * Model Fetcher — background model list refresh from Codex backend.
 *
 * - Probes known endpoints to discover the models list
 * - Normalizes and merges into the model store
 * - Non-fatal: all errors log warnings but never crash the server
 */

import { CodexApi } from "../proxy/codex-api.js";
import { applyBackendModels, type BackendModelEntry } from "./model-store.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { jitter } from "../utils/jitter.js";

const REFRESH_INTERVAL_HOURS = 1;
const INITIAL_DELAY_MS = 5_000; // 5s after startup

let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _accountPool: AccountPool | null = null;
let _cookieJar: CookieJar | null = null;

/**
 * Fetch models from the Codex backend using an available account.
 */
async function fetchModelsFromBackend(
  accountPool: AccountPool,
  cookieJar: CookieJar,
): Promise<void> {
  if (!accountPool.isAuthenticated()) return; // silently skip when no accounts

  const acquired = accountPool.acquire();
  if (!acquired) {
    console.warn("[ModelFetcher] No available account — skipping model fetch");
    return;
  }

  try {
    const api = new CodexApi(
      acquired.token,
      acquired.accountId,
      cookieJar,
      acquired.entryId,
    );

    const models = await api.getModels();
    if (models && models.length > 0) {
      applyBackendModels(models);
      console.log(`[ModelFetcher] Fetched ${models.length} models from backend`);
    } else {
      console.log("[ModelFetcher] Backend returned empty model list — keeping static models");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ModelFetcher] Backend fetch failed: ${msg}`);
  } finally {
    accountPool.release(acquired.entryId);
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
): void {
  _accountPool = accountPool;
  _cookieJar = cookieJar;

  // Initial fetch after short delay
  _refreshTimer = setTimeout(async () => {
    await fetchModelsFromBackend(accountPool, cookieJar);
    scheduleNext(accountPool, cookieJar);
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
      await fetchModelsFromBackend(accountPool, cookieJar);
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
    fetchModelsFromBackend(_accountPool, _cookieJar).catch((err) => {
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
