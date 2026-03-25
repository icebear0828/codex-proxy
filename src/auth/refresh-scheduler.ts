/**
 * RefreshScheduler — per-account JWT auto-refresh.
 * Schedules a refresh at `exp - margin` for each account.
 * Uses OAuth refresh_token instead of Codex CLI.
 *
 * Features:
 * - Exponential backoff (5 attempts: 5s → 15s → 45s → 135s → 300s)
 * - Permanent failure detection (invalid_grant / invalid_token)
 * - Recovery scheduling (10 min) for temporary failures
 * - Crash recovery: "refreshing" → immediate retry, "expired" + refreshToken → delayed retry
 */

import { getConfig } from "../config.js";
import { decodeJwtPayload } from "./jwt-utils.js";
import { refreshAccessToken } from "./oauth-pkce.js";
import { jitter, jitterInt } from "../utils/jitter.js";
import type { AccountPool } from "./account-pool.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";

/** Errors that indicate the refresh token itself is invalid (permanent failure). */
const PERMANENT_ERRORS = ["invalid_grant", "invalid_token", "access_denied"];

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 5_000;
const RECOVERY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
/** Require this many consecutive permanent errors before marking expired. */
const PERMANENT_THRESHOLD = 2;

export class RefreshScheduler {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pool: AccountPool;
  private proxyPool: ProxyPool | null = null;

  /** Semaphore: number of refresh requests currently in flight. */
  private _running = 0;
  /** Queue of pending refresh callbacks waiting for a slot. */
  private _queue: Array<() => void> = [];

  constructor(pool: AccountPool) {
    this.pool = pool;
    this.scheduleAll();
  }

  /** Set proxy pool for per-account proxy routing during refresh. */
  setProxyPool(proxyPool: ProxyPool): void {
    this.proxyPool = proxyPool;
  }

  /** Schedule refresh for all accounts in the pool. */
  scheduleAll(): void {
    const config = getConfig();
    if (!config.auth.refresh_enabled) {
      console.log("[RefreshScheduler] Auto-refresh disabled (refresh_enabled = false)");
      return;
    }

    let expiredIndex = 0;
    for (const entry of this.pool.getAllEntries()) {
      // Skip accounts without refresh token — can't auto-refresh
      if (!entry.refreshToken) continue;
      // Skip permanently disabled/banned accounts
      if (entry.status === "disabled" || entry.status === "banned") continue;

      if (entry.status === "refreshing") {
        // Crash recovery: was mid-refresh when process died
        console.log(`[RefreshScheduler] Account ${entry.id}: recovering from 'refreshing' state`);
        this.doRefresh(entry.id);
      } else if (entry.status === "expired") {
        // Recovery attempt — stagger by 2s per account to avoid burst
        const delay = 30_000 + expiredIndex * 2_000;
        expiredIndex++;
        console.log(`[RefreshScheduler] Account ${entry.id}: expired, recovery attempt in ${Math.round(delay / 1000)}s`);
        const timer = setTimeout(() => {
          this.timers.delete(entry.id);
          this.doRefresh(entry.id);
        }, delay);
        if (timer.unref) timer.unref();
        this.timers.set(entry.id, timer);
      } else {
        // active / rate_limited — schedule refresh at token expiry
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
    const refreshAt = payload.exp - jitter(config.auth.refresh_margin_seconds, 0.15);
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

  /** Cancel all timers and drain the semaphore queue. */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    // Unblock any waiters so their promises resolve (doRefresh will
    // bail out via getEntry returning null or scheduler being dead).
    for (const resolve of this._queue) resolve();
    this._queue.length = 0;
    this._running = 0;
  }

  // ── Internal ────────────────────────────────────────────────────

  /** Acquire a semaphore slot, waiting if at capacity. */
  private async acquireSlot(): Promise<void> {
    const limit = getConfig().auth.refresh_concurrency;
    if (this._running < limit) {
      this._running++;
      return;
    }
    await new Promise<void>((resolve) => this._queue.push(resolve));
    this._running++;
  }

  /** Release a semaphore slot, unblocking the next waiter. */
  private releaseSlot(): void {
    this._running--;
    const next = this._queue.shift();
    if (next) next();
  }

  private async doRefresh(entryId: string): Promise<void> {
    await this.acquireSlot();
    try {
      await this._doRefreshInner(entryId);
    } finally {
      this.releaseSlot();
    }
  }

  private async _doRefreshInner(entryId: string): Promise<void> {
    const entry = this.pool.getEntry(entryId);
    if (!entry) return;

    if (!entry.refreshToken) {
      console.warn(
        `[RefreshScheduler] Account ${entryId} has no refresh_token, cannot auto-refresh. Re-login required at /`,
      );
      this.pool.markStatus(entryId, "expired");
      return;
    }

    console.log(`[RefreshScheduler] Refreshing account ${entryId} (${entry.email ?? "?"})`);
    this.pool.markStatus(entryId, "refreshing");

    const accountProxyUrl = this.proxyPool?.resolveProxyUrl(entryId);
    let permanentHits = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const tokens = await refreshAccessToken(entry.refreshToken, accountProxyUrl);
        // Update token and refresh_token (if a new one was issued)
        this.pool.updateToken(
          entryId,
          tokens.access_token,
          tokens.refresh_token,
        );
        console.log(`[RefreshScheduler] Account ${entryId} refreshed successfully`);
        this.scheduleOne(entryId, tokens.access_token);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Track consecutive permanent errors — only mark expired after threshold
        const isPermanent = PERMANENT_ERRORS.some((e) => msg.toLowerCase().includes(e));
        if (isPermanent) {
          permanentHits++;
          if (permanentHits >= PERMANENT_THRESHOLD) {
            console.error(`[RefreshScheduler] Permanent failure (${permanentHits}x) for ${entryId}: ${msg}`);
            this.pool.markStatus(entryId, "expired");
            return;
          }
          console.warn(`[RefreshScheduler] Permanent error (${permanentHits}/${PERMANENT_THRESHOLD}) for ${entryId}: ${msg}, retrying...`);
        }

        if (attempt < MAX_ATTEMPTS) {
          // Exponential backoff: 5s, 15s, 45s, 135s, 300s (capped)
          const backoff = Math.min(BASE_DELAY_MS * Math.pow(3, attempt - 1), 300_000);
          const retryDelay = jitterInt(backoff, 0.3);
          console.warn(
            `[RefreshScheduler] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${entryId}: ${msg}, retrying in ${Math.round(retryDelay / 1000)}s...`,
          );
          await new Promise((r) => setTimeout(r, retryDelay));
        } else {
          console.error(
            `[RefreshScheduler] All ${MAX_ATTEMPTS} attempts failed for ${entryId}: ${msg}`,
          );
          // Don't mark expired — schedule recovery attempt in 10 minutes
          this.pool.markStatus(entryId, "active"); // keep active so it can still be used
          this.scheduleRecovery(entryId);
        }
      }
    }
  }

  /**
   * Schedule a recovery refresh attempt after all retries are exhausted.
   * Gives the server time to recover from temporary issues.
   */
  private scheduleRecovery(entryId: string): void {
    const delay = jitterInt(RECOVERY_DELAY_MS, 0.2);
    console.log(
      `[RefreshScheduler] Recovery attempt for ${entryId} in ${Math.round(delay / 60000)}m`,
    );
    const timer = setTimeout(() => {
      this.timers.delete(entryId);
      this.doRefresh(entryId);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(entryId, timer);
  }
}
