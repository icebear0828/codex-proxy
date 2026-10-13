/**
 * KeepaliveScheduler — periodically calls /codex/usage for each active account
 * to refresh quota window state and detect deactivated/banned accounts early.
 *
 * Two scheduling modes (config.account_keepalive.mode):
 *   "fixed_times"  — fires at specific HH:mm times each day (default 07:00, 13:00, 18:00)
 *   "interval"     — fires every interval_minutes
 */

import type { AccountPool } from "./account-pool.js";
import type { AccountEntry } from "./types.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { CodexApi } from "../proxy/codex-api.js";
import { toQuota } from "./quota-utils.js";
import { getConfig } from "../config.js";
import type { AppConfig } from "../config-schema.js";

export type KeepaliveResult = "ok" | "skipped" | "error";

export interface AccountKeepaliveResult {
  entryId: string;
  email: string;
  result: KeepaliveResult;
  error?: string;
  at: number;
}

/** Compute the next fire time from config. Returns null when scheduling is not possible. */
export function computeNextRun(cfg: AppConfig["account_keepalive"]): Date | null {
  const now = new Date();

  if (cfg.mode === "interval") {
    if (!cfg.interval_minutes || cfg.interval_minutes <= 0) return null;
    return new Date(now.getTime() + cfg.interval_minutes * 60_000);
  }

  // fixed_times mode — find the earliest upcoming HH:mm slot
  const times = cfg.fixed_times;
  if (!times.length) return null;

  const candidates: Date[] = [];
  for (const t of times) {
    const [hStr, mStr] = t.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;

    const today = new Date(now);
    today.setHours(h, m, 0, 0);

    if (today.getTime() > now.getTime()) {
      candidates.push(today);
    } else {
      // Slot already passed today — schedule for tomorrow
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      candidates.push(tomorrow);
    }
  }

  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KeepaliveScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private destroyed = false;
  private lastRun: Date | null = null;
  private nextRun: Date | null = null;
  private lastResults: AccountKeepaliveResult[] = [];

  constructor(
    private readonly pool: AccountPool,
    private readonly cookieJar?: CookieJar | null,
  ) {}

  /** Begin scheduling. Call after server startup. */
  start(): void {
    if (this.destroyed) return;
    this.scheduleNext();
  }

  /** Cancel the pending timer but keep the instance reusable. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRun = null;
  }

  /** Permanently shut down. */
  destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  getStatus(): {
    enabled: boolean;
    mode: string;
    nextRun: string | null;
    lastRun: string | null;
    lastResults: AccountKeepaliveResult[];
  } {
    const cfg = getConfig().account_keepalive;
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      nextRun: this.nextRun?.toISOString() ?? null,
      lastRun: this.lastRun?.toISOString() ?? null,
      lastResults: this.lastResults,
    };
  }

  /** Admin: trigger an immediate keepalive run outside of the normal schedule. */
  async runNow(): Promise<AccountKeepaliveResult[]> {
    return this.executeAll();
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    const cfg = getConfig().account_keepalive;
    if (!cfg.enabled) return;

    const next = computeNextRun(cfg);
    if (!next) return;

    this.nextRun = next;
    const delay = Math.max(next.getTime() - Date.now(), 0);
    this.timer = setTimeout(() => {
      if (this.destroyed) return;
      void this.executeAll().finally(() => this.scheduleNext());
    }, delay);
    // Don't prevent process exit
    if (this.timer.unref) this.timer.unref();
  }

  private async executeAll(): Promise<AccountKeepaliveResult[]> {
    if (this.running) return [];
    this.running = true;
    this.lastRun = new Date();

    try {
      const cfg = getConfig().account_keepalive;
      const { concurrency, per_account_delay_ms } = cfg;

      const accounts = this.pool.getAllEntries().filter((a) => a.status === "active" && a.token);
      const results: AccountKeepaliveResult[] = [];

      // Process in batches of `concurrency` with a stagger delay between batches
      for (let i = 0; i < accounts.length; i += concurrency) {
        if (i > 0 && per_account_delay_ms > 0) {
          await sleep(per_account_delay_ms);
        }
        const batch = accounts.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((a) => this.runOne(a)));
        results.push(...batchResults);
      }

      this.lastResults = results;
      return results;
    } finally {
      this.running = false;
    }
  }

  private async runOne(entry: AccountEntry): Promise<AccountKeepaliveResult> {
    if (entry.status !== "active") {
      return { entryId: entry.id, email: entry.email ?? "", result: "skipped", at: Date.now() };
    }

    try {
      const proxyUrl = getConfig().tls.proxy_url ?? null;
      const api = new CodexApi(entry.token, entry.accountId ?? entry.id, this.cookieJar, entry.id, proxyUrl);
      const usage = await api.getUsage();
      this.pool.updateCachedQuota(entry.id, toQuota(usage));
      return { entryId: entry.id, email: entry.email ?? "", result: "ok", at: Date.now() };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const lower = error.toLowerCase();
      if (lower.includes("deactivated") || (lower.includes("unauthorized") && !lower.includes("rate"))) {
        this.pool.markStatus(entry.id, "expired");
      }
      return { entryId: entry.id, email: entry.email ?? "", result: "error", error, at: Date.now() };
    }
  }
}
