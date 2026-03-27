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
    usage?: { input_tokens?: number; output_tokens?: number },
  ): void {
    this.lifecycle.release(entryId, usage);
  }

  releaseWithoutCounting(entryId: string): void {
    this.lifecycle.releaseWithoutCounting(entryId);
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
    return this.registry.removeAccount(id);
  }

  updateToken(entryId: string, newToken: string, refreshToken?: string): void {
    this.registry.updateToken(entryId, newToken, refreshToken);
  }

  setLabel(entryId: string, label: string | null): boolean {
    return this.registry.setLabel(entryId, label);
  }

  // ── Status mutations (coordinate registry + lifecycle lock clear) ─

  markStatus(entryId: string, status: AccountEntry["status"]): void {
    if (this.registry.markStatus(entryId, status)) {
      this.lifecycle.clearLock(entryId);
    }
  }

  markRateLimited(
    entryId: string,
    options?: { retryAfterSec?: number; countRequest?: boolean },
  ): void {
    if (this.registry.markRateLimited(entryId, this.rateLimitBackoffSeconds, options)) {
      this.lifecycle.clearLock(entryId);
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

  destroy(): void {
    this.registry.destroy();
  }
}
