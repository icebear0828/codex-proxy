/**
 * ModelFetcher — background model list refresh from Codex backend.
 *
 * Phase 8a: converted from module-level singletons to class.
 * Free function wrappers preserve backward compatibility for 7 importers.
 */

import { CodexApi } from "../proxy/codex-api.js";
import { applyBackendModelsForPlan } from "./model-store.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { jitter } from "../utils/jitter.js";

const REFRESH_INTERVAL_HOURS = 1;
const INITIAL_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 12;

export class ModelFetcher {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private hasFetchedOnce = false;
  private stopped = false;
  private pool: AccountPool;
  private cookieJar: CookieJar;
  private proxyPool: ProxyPool | null;

  constructor(pool: AccountPool, cookieJar: CookieJar, proxyPool: ProxyPool | null) {
    this.pool = pool;
    this.cookieJar = cookieJar;
    this.proxyPool = proxyPool;
  }

  start(): void {
    this.stopped = false;
    this.hasFetchedOnce = false;
    this.refreshTimer = setTimeout(() => {
      this.attemptInitialFetch(0);
    }, INITIAL_DELAY_MS);
    console.log("[ModelFetcher] Scheduled initial model fetch in 1s");
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      console.log("[ModelFetcher] Stopped model refresh");
    }
  }

  triggerImmediate(): void {
    this.fetchModelsFromBackend()
      .then((success) => {
        if (success) this.hasFetchedOnce = true;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ModelFetcher] Immediate refresh failed: ${msg}`);
      });
  }

  hasFetched(): boolean {
    return this.hasFetchedOnce;
  }

  private async fetchModelsFromBackend(): Promise<boolean> {
    if (!this.pool.isAuthenticated()) return false;

    const planAccounts = this.pool.getDistinctPlanAccounts();
    if (planAccounts.length === 0) {
      console.warn("[ModelFetcher] No available accounts — skipping model fetch");
      return false;
    }

    console.log(`[ModelFetcher] Fetching models for ${planAccounts.length} plan(s): ${planAccounts.map((p) => p.planType).join(", ")}`);

    let anySuccess = false;
    const results = await Promise.allSettled(
      planAccounts.map(async (pa) => {
        try {
          const proxyUrl = this.proxyPool?.resolveProxyUrl(pa.entryId);
          const api = new CodexApi(pa.token, pa.accountId, this.cookieJar, pa.entryId, proxyUrl);
          const models = await api.getModels();
          if (models && models.length > 0) {
            applyBackendModelsForPlan(pa.planType, models);
            console.log(`[ModelFetcher] Plan "${pa.planType}": ${models.length} models`);
            anySuccess = true;
          } else {
            console.log(`[ModelFetcher] Plan "${pa.planType}": empty model list — keeping existing`);
          }
        } finally {
          this.pool.release(pa.entryId);
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

  private attemptInitialFetch(attempt: number): void {
    if (this.stopped) return;
    this.fetchModelsFromBackend()
      .then((success) => {
        if (this.stopped) return;
        if (success) {
          this.hasFetchedOnce = true;
          this.scheduleNext();
        } else if (attempt < MAX_RETRIES) {
          console.log(`[ModelFetcher] Accounts not ready, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
          this.refreshTimer = setTimeout(() => {
            this.attemptInitialFetch(attempt + 1);
          }, RETRY_DELAY_MS);
        } else {
          console.warn("[ModelFetcher] Max retries reached, falling back to hourly refresh");
          this.scheduleNext();
        }
      })
      .catch(() => {
        if (!this.stopped) this.scheduleNext();
      });
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const intervalMs = jitter(REFRESH_INTERVAL_HOURS * 3600 * 1000, 0.15);
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.fetchModelsFromBackend();
      } finally {
        if (!this.stopped) this.scheduleNext();
      }
    }, intervalMs);
  }
}

// ── Free function wrappers (backward compatibility) ──────────────────

let _instance: ModelFetcher | null = null;

export function startModelRefresh(
  accountPool: AccountPool,
  cookieJar: CookieJar,
  proxyPool?: ProxyPool,
): void {
  _instance?.stop();
  _instance = new ModelFetcher(accountPool, cookieJar, proxyPool ?? null);
  _instance.start();
}

export function triggerImmediateRefresh(): void {
  _instance?.triggerImmediate();
}

export function hasFetchedModels(): boolean {
  return _instance?.hasFetched() ?? false;
}

export function stopModelRefresh(): void {
  _instance?.stop();
  _instance = null;
}
