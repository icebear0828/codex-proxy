/**
 * AccountPool — facade composing AccountRegistry (state + CRUD) and
 * AccountLifecycle (acquire locks + rotation).
 *
 * All 31 public methods delegate to the sub-modules.
 * External importers see the exact same API — zero migration needed.
 */

import { getConfig } from "../config.js";
import { createFsPersistence } from "./account-persistence.js";
import { AccountRegistry } from "./account-registry.js";
import { AccountLifecycle } from "./account-lifecycle.js";
import type { AccountPersistence } from "./account-persistence.js";
import type { RotationStrategyName } from "./rotation-strategy.js";
import type {
  AccountEntry,
  AccountInfo,
  AcquiredAccount,
  CodexQuota,
} from "./types.js";

export class AccountPool {
  private registry: AccountRegistry;
  private lifecycle: AccountLifecycle;
  private _onExpired?: (entryId: string) => void;

  constructor(options?: {
    persistence?: AccountPersistence;
    rotationStrategy?: RotationStrategyName;
    initialToken?: string | null;
    rateLimitBackoffSeconds?: number;
  }) {
    const persistence = options?.persistence ?? createFsPersistence();

    const needsConfig =
      options?.rotationStrategy === undefined ||
      options?.initialToken === undefined ||
      options?.rateLimitBackoffSeconds === undefined;
    const config = needsConfig ? getConfig() : undefined;

    const strategyName = options?.rotationStrategy ?? config!.auth.rotation_strategy;
    this.rateLimitBackoffSeconds =
      options?.rateLimitBackoffSeconds ?? config!.auth.rate_limit_backoff_seconds;

    // Load persisted entries
    const { entries } = persistence.load();
    this.registry = new AccountRegistry(persistence, entries);
    this.lifecycle = new AccountLifecycle(this.registry, strategyName);

    // Override with initial token if set
    const initialToken =
      options?.initialToken !== undefined
        ? options.initialToken
        : config!.auth.jwt_token;
    if (initialToken) {
      this.addAccount(initialToken);
    }
    const envToken = process.env.CODEX_JWT_TOKEN;
    if (envToken) {
      this.addAccount(envToken);
    }
  }

  private rateLimitBackoffSeconds: number;

  // ── Lifecycle (acquire/release) ───────────────────────────────────

  acquire(options?: { model?: string; excludeIds?: string[]; preferredEntryId?: string }): AcquiredAccount | null {
    return this.lifecycle.acquire(options);
  }

  release(
    entryId: string,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_tokens?: number;
      image_input_tokens?: number;
      image_output_tokens?: number;
      image_request_attempted?: boolean;
      image_request_succeeded?: boolean;
    },
  ): void {
    this.lifecycle.release(entryId, usage);
  }

  releaseWithoutCounting(entryId: string): void {
    this.lifecycle.releaseWithoutCounting(entryId);
  }

  /** Fast check: is there at least one active account not in the exclude list? */
  hasAvailableAccounts(excludeIds?: string[]): boolean {
    return this.registry.hasAvailableAccounts(excludeIds);
  }

  setRotationStrategy(name: "least_used" | "round_robin" | "sticky"): void {
    this.lifecycle.setRotationStrategy(name);
  }

  getDistinctPlanAccounts(): Array<{
    planType: string;
    entryId: string;
    token: string;
    accountId: string | null;
  }> {
    return this.lifecycle.getDistinctPlanAccounts();
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  addAccount(token: string, refreshToken?: string | null): string {
    return this.registry.addAccount(token, refreshToken);
  }

  removeAccount(id: string): boolean {
    this.lifecycle.clearLock(id);
    this.evictWsPool(id);
    return this.registry.removeAccount(id);
  }

  updateToken(entryId: string, newToken: string, refreshToken?: string): void {
    this.registry.updateToken(entryId, newToken, refreshToken);
    // The new access_token doesn't take effect on already-open WebSocket
    // sessions (the upstream auth header is captured at handshake), so any
    // pooled WS for this entry is now using a stale credential. Evict so the
    // next request opens a fresh WS with the refreshed token.
    this.evictWsPool(entryId);
  }

  /** Drop any pooled WebSocket connections for `entryId`. Used by status
   *  mutations and token refresh to prevent in-flight reuse from carrying
   *  stale auth or routing into a backend the account is no longer welcome
   *  on. Lazy-imports ws-pool so this module doesn't pull the proxy layer
   *  into bootstrap when the pool isn't otherwise reachable. */
  private evictWsPool(entryId: string): void {
    // Avoid hard import: account-pool is also exercised in unit tests that
    // never touch the WS layer, and dynamic resolution keeps that contract.
    void import("../proxy/ws-pool.js")
      .then((mod) => mod.getWsPool().evictByEntryId(entryId))
      .catch(() => { /* pool unavailable in this build/test context — ignore */ });
  }

  setLabel(entryId: string, label: string | null): boolean {
    return this.registry.setLabel(entryId, label);
  }

  // ── Status mutations (coordinate registry + lifecycle lock clear) ─

  /** Register a callback invoked when an account is marked "expired" (e.g. 401 from upstream). */
  onExpired(cb: (entryId: string) => void): void {
    this._onExpired = cb;
  }

  markStatus(entryId: string, status: AccountEntry["status"]): void {
    if (this.registry.markStatus(entryId, status)) {
      this.lifecycle.clearLock(entryId);
      // Status transitions to expired/banned/disabled make the account
      // unusable; reusing a pooled WS would just hit the same wall on the
      // upstream side. Evict so the pool doesn't hold a doomed connection.
      if (status !== "active") this.evictWsPool(entryId);
    }
    if (status === "expired" && this._onExpired) {
      this._onExpired(entryId);
    }
  }

  markRateLimited(
    entryId: string,
    options?: { retryAfterSec?: number; countRequest?: boolean },
  ): void {
    if (this.registry.markRateLimited(entryId, this.rateLimitBackoffSeconds, options)) {
      this.lifecycle.clearLock(entryId);
      this.evictWsPool(entryId);
    }
  }

  clearRateLimit(entryId: string): void {
    if (this.registry.clearRateLimit(entryId)) {
      this.lifecycle.clearLock(entryId);
    }
  }

  markQuotaExhausted(entryId: string, resetAtUnix: number | null): void {
    if (this.registry.markQuotaExhausted(entryId, resetAtUnix)) {
      this.lifecycle.clearLock(entryId);
    }
  }

  // ── Quota / usage ─────────────────────────────────────────────────

  recordEmptyResponse(entryId: string): void {
    this.registry.recordEmptyResponse(entryId);
  }

  updateCachedQuota(entryId: string, quota: CodexQuota): void {
    this.registry.updateCachedQuota(entryId, quota);
  }

  syncRateLimitWindow(
    entryId: string,
    newResetAt: number | null,
    limitWindowSeconds: number | null,
  ): void {
    this.registry.syncRateLimitWindow(entryId, newResetAt, limitWindowSeconds);
  }

  resetUsage(entryId: string): boolean {
    return this.registry.resetUsage(entryId);
  }

  // ── Query ─────────────────────────────────────────────────────────

  getAccounts(): AccountInfo[] {
    return this.registry.getAccounts();
  }

  getEntry(entryId: string): AccountEntry | undefined {
    return this.registry.getEntry(entryId);
  }

  getAllEntries(): AccountEntry[] {
    return this.registry.getAllEntries();
  }

  isAuthenticated(): boolean {
    return this.registry.isAuthenticated();
  }

  /** @deprecated Use getAccounts() instead. */
  getUserInfo(): { email?: string; accountId?: string; planType?: string } | null {
    return this.registry.getUserInfo();
  }

  /** @deprecated Use getAccounts() instead. */
  getProxyApiKey(): string | null {
    return this.registry.getProxyApiKey();
  }

  validateProxyApiKey(key: string): boolean {
    return this.registry.validateProxyApiKey(key);
  }

  /** @deprecated Use removeAccount() instead. */
  clearToken(): void {
    this.lifecycle.clearAllLocks();
    this.registry.clearToken();
  }

  getPoolSummary(): {
    total: number;
    active: number;
    expired: number;
    quota_exhausted: number;
    rate_limited: number;
    refreshing: number;
    disabled: number;
    banned: number;
  } {
    return this.registry.getPoolSummary();
  }

  // ── Persistence ───────────────────────────────────────────────────

  persistNow(): void {
    this.registry.persistNow();
  }

  /**
   * Read a single account's refresh token directly from disk (accounts.json).
   * Used by RefreshScheduler to detect cross-process RT updates before refreshing.
   * Returns null if not found or on read error.
   */
  readEntryRTFromDisk(entryId: string): string | null {
    return this.registry.readEntryRTFromDisk(entryId);
  }

  destroy(): void {
    this.registry.destroy();
  }
}
