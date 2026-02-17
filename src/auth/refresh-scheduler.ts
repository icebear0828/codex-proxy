/**
 * RefreshScheduler — per-account JWT auto-refresh.
 * Schedules a refresh at `exp - margin` for each account.
 */

import { getConfig } from "../config.js";
import { decodeJwtPayload } from "./jwt-utils.js";
import { refreshTokenViaCli } from "./chatgpt-oauth.js";
import type { AccountPool } from "./account-pool.js";

export class RefreshScheduler {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pool: AccountPool;

  constructor(pool: AccountPool) {
    this.pool = pool;
    this.scheduleAll();
  }

  /** Schedule refresh for all accounts in the pool. */
  scheduleAll(): void {
    for (const entry of this.pool.getAllEntries()) {
      if (entry.status === "active" || entry.status === "refreshing") {
        this.scheduleOne(entry.id, entry.token);
      }
    }
  }

  /** Schedule refresh for a single account. */
  scheduleOne(entryId: string, token: string): void {
    // Clear existing timer
    this.clearOne(entryId);

    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== "number") return;

    const config = getConfig();
    const refreshAt = payload.exp - config.auth.refresh_margin_seconds;
    const delayMs = (refreshAt - Math.floor(Date.now() / 1000)) * 1000;

    if (delayMs <= 0) {
      // Already past refresh time — attempt refresh immediately
      this.doRefresh(entryId);
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(entryId);
      this.doRefresh(entryId);
    }, delayMs);

    // Prevent the timer from keeping the process alive
    if (timer.unref) timer.unref();

    this.timers.set(entryId, timer);

    const expiresIn = Math.round(delayMs / 1000);
    console.log(
      `[RefreshScheduler] Account ${entryId}: refresh scheduled in ${expiresIn}s`,
    );
  }

  /** Cancel timer for one account. */
  clearOne(entryId: string): void {
    const timer = this.timers.get(entryId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(entryId);
    }
  }

  /** Cancel all timers. */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ── Internal ────────────────────────────────────────────────────

  private async doRefresh(entryId: string): Promise<void> {
    const entry = this.pool.getEntry(entryId);
    if (!entry) return;

    console.log(`[RefreshScheduler] Refreshing account ${entryId} (${entry.email ?? "?"})`);
    this.pool.markStatus(entryId, "refreshing");

    try {
      const newToken = await refreshTokenViaCli();
      this.pool.updateToken(entryId, newToken);
      console.log(`[RefreshScheduler] Account ${entryId} refreshed successfully`);
      // Re-schedule for the new token
      this.scheduleOne(entryId, newToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RefreshScheduler] Failed to refresh ${entryId}: ${msg}`);
      this.pool.markStatus(entryId, "expired");
    }
  }
}
