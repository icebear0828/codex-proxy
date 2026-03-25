/**
 * AccountPool — multi-account manager with least-used rotation.
 * Replaces the single-account AuthManager.
 */

import { randomBytes } from "crypto";
import { getConfig } from "../config.js";
import { jitter } from "../utils/jitter.js";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import { getModelPlanTypes, isPlanFetched } from "../models/model-store.js";
import { getRotationStrategy } from "./rotation-strategy.js";
import { createFsPersistence } from "./account-persistence.js";
import type { AccountPersistence } from "./account-persistence.js";
import type { RotationStrategy, RotationState } from "./rotation-strategy.js";
import type {
  AccountEntry,
  AccountInfo,
  AccountUsage,
  AcquiredAccount,
  AccountsFile,
  CodexQuota,
} from "./types.js";

// P1-4: Lock TTL — auto-release locks older than this
const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class AccountPool {
  private accounts: Map<string, AccountEntry> = new Map();
  private acquireLocks: Map<string, number> = new Map(); // entryId → timestamp
  private strategy: RotationStrategy;
  private rotationState: RotationState = { roundRobinIndex: 0 };
  private persistence: AccountPersistence;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: { persistence?: AccountPersistence }) {
    this.persistence = options?.persistence ?? createFsPersistence();
    const config = getConfig();
    this.strategy = getRotationStrategy(config.auth.rotation_strategy);

    // Load persisted accounts (handles migration from legacy format)
    const { entries } = this.persistence.load();
    for (const entry of entries) {
      this.accounts.set(entry.id, entry);
    }

    // Override with config jwt_token if set
    if (config.auth.jwt_token) {
      this.addAccount(config.auth.jwt_token);
    }
    const envToken = process.env.CODEX_JWT_TOKEN;
    if (envToken) {
      this.addAccount(envToken);
    }
  }

  // ── Core operations ─────────────────────────────────────────────

  /**
   * Acquire the best available account for a request.
   * Returns null if no accounts are available.
   *
   * @param options.model - Prefer accounts whose planType matches this model's known plans
   * @param options.excludeIds - Entry IDs to exclude (e.g. already tried)
   */
  acquire(options?: { model?: string; excludeIds?: string[] }): AcquiredAccount | null {
    const now = new Date();
    const nowMs = now.getTime();

    // Update statuses before selecting
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
    }

    // P1-4: Auto-release stale locks (older than TTL)
    for (const [id, lockedAt] of this.acquireLocks) {
      if (nowMs - lockedAt > ACQUIRE_LOCK_TTL_MS) {
        console.warn(`[AccountPool] Auto-releasing stale lock for ${id} (locked ${Math.round((nowMs - lockedAt) / 1000)}s ago)`);
        this.acquireLocks.delete(id);
      }
    }

    const excludeSet = new Set(options?.excludeIds ?? []);

    // Filter available accounts
    const available = [...this.accounts.values()].filter(
      (a) => a.status === "active" && !this.acquireLocks.has(a.id) && !excludeSet.has(a.id),
    );

    if (available.length === 0) return null;

    // Model-aware selection: prefer accounts whose planType matches the model's known plans.
    // Accounts whose planType has never been fetched are treated as "possibly compatible"
    // to avoid false 503s when a plan's model fetch failed at startup.
    let candidates = available;
    if (options?.model) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = available.filter((a) => {
          if (!a.planType) return false;
          // Plan is known to support this model
          if (planSet.has(a.planType)) return true;
          // Plan has never been fetched — include as possibly compatible
          return !isPlanFetched(a.planType);
        });
        if (matched.length > 0) {
          candidates = matched;
        } else {
          // All accounts belong to plans that were fetched but don't include this model
          return null;
        }
      }
    }

    const selected = this.strategy.select(candidates, this.rotationState);
    this.acquireLocks.set(selected.id, Date.now());
    return {
      entryId: selected.id,
      token: selected.token,
      accountId: selected.accountId,
    };
  }

  /**
   * Switch rotation strategy at runtime (e.g. from admin API).
   */
  setRotationStrategy(name: "least_used" | "round_robin" | "sticky"): void {
    this.strategy = getRotationStrategy(name);
    this.rotationState.roundRobinIndex = 0;
  }

  /**
   * Get one account per distinct planType for model discovery.
   * Each returned account is locked (caller must release).
   */
  getDistinctPlanAccounts(): Array<{ planType: string; entryId: string; token: string; accountId: string | null }> {
    const now = new Date();
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
    }

    const available = [...this.accounts.values()].filter(
      (a) => a.status === "active" && !this.acquireLocks.has(a.id) && a.planType,
    );

    // Group by planType, pick least-used from each group
    const byPlan = new Map<string, AccountEntry[]>();
    for (const a of available) {
      const plan = a.planType!;
      let group = byPlan.get(plan);
      if (!group) {
        group = [];
        byPlan.set(plan, group);
      }
      group.push(a);
    }

    const result: Array<{ planType: string; entryId: string; token: string; accountId: string | null }> = [];
    for (const [plan, group] of byPlan) {
      const selected = this.strategy.select(group, this.rotationState);
      this.acquireLocks.set(selected.id, Date.now());
      result.push({
        planType: plan,
        entryId: selected.id,
        token: selected.token,
        accountId: selected.accountId,
      });
    }

    return result;
  }

  /**
   * Release an account after a request completes.
   */
  release(
    entryId: string,
    usage?: { input_tokens?: number; output_tokens?: number },
  ): void {
    this.acquireLocks.delete(entryId);
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    entry.usage.request_count++;
    entry.usage.last_used = new Date().toISOString();
    if (usage) {
      entry.usage.input_tokens += usage.input_tokens ?? 0;
      entry.usage.output_tokens += usage.output_tokens ?? 0;
    }
    // Increment window counters
    entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    if (usage) {
      entry.usage.window_input_tokens = (entry.usage.window_input_tokens ?? 0) + (usage.input_tokens ?? 0);
      entry.usage.window_output_tokens = (entry.usage.window_output_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    this.schedulePersist();
  }

  /**
   * Release an account without counting usage (for diagnostics).
   */
  releaseWithoutCounting(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  /**
   * Mark an account as rate-limited after a 429.
   * P1-6: countRequest option to track 429s as usage without exposing entry internals.
   */
  markRateLimited(
    entryId: string,
    options?: { retryAfterSec?: number; countRequest?: boolean },
  ): void {
    this.acquireLocks.delete(entryId);
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    const config = getConfig();
    const backoff = jitter(
      options?.retryAfterSec ?? config.auth.rate_limit_backoff_seconds,
      0.2,
    );
    const until = new Date(Date.now() + backoff * 1000);

    entry.status = "rate_limited";
    entry.usage.rate_limit_until = until.toISOString();

    if (options?.countRequest) {
      entry.usage.request_count++;
      entry.usage.last_used = new Date().toISOString();
      entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    }

    this.schedulePersist();
  }

  // ── Account management ──────────────────────────────────────────

  /**
   * Add an account from a raw JWT token. Returns the entry ID.
   * Deduplicates by accountId.
   */
  addAccount(token: string, refreshToken?: string | null): string {
    const accountId = extractChatGptAccountId(token);
    const profile = extractUserProfile(token);
    const userId = profile?.chatgpt_user_id ?? null;

    // Deduplicate by accountId + userId (team members share accountId but have distinct userId)
    // Fallback: if accountId is missing, deduplicate by token to prevent unbounded growth
    for (const existing of this.accounts.values()) {
      if (accountId) {
        if (existing.accountId === accountId && existing.userId === userId) {
          existing.token = token;
          if (refreshToken !== undefined) {
            existing.refreshToken = refreshToken ?? null;
          }
          existing.email = profile?.email ?? existing.email;
          existing.planType = profile?.chatgpt_plan_type ?? existing.planType;
          existing.status = isTokenExpired(token) ? "expired" : "active";
          this.persistNow();
          return existing.id;
        }
      } else if (existing.token === token) {
        // Same token without accountId — already exists, skip
        return existing.id;
      }
    }

    const id = randomBytes(8).toString("hex");
    const entry: AccountEntry = {
      id,
      token,
      refreshToken: refreshToken ?? null,
      email: profile?.email ?? null,
      accountId,
      userId,
      label: null,
      planType: profile?.chatgpt_plan_type ?? null,
      proxyApiKey: "codex-proxy-" + randomBytes(24).toString("hex"),
      status: isTokenExpired(token) ? "expired" : "active",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        empty_response_count: 0,
        last_used: null,
        rate_limit_until: null,
        window_request_count: 0,
        window_input_tokens: 0,
        window_output_tokens: 0,
        window_counters_reset_at: null,
        limit_window_seconds: null,
      },
      addedAt: new Date().toISOString(),
      cachedQuota: null,
      quotaFetchedAt: null,
    };

    this.accounts.set(id, entry);
    this.persistNow(); // Critical data — persist immediately
    return id;
  }

  /**
   * Record an empty response for an account (HTTP 200 but zero text deltas).
   */
  recordEmptyResponse(entryId: string): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.usage.empty_response_count++;
    this.schedulePersist();
  }

  /**
   * Update cached quota for an account (called by background quota refresher).
   */
  updateCachedQuota(entryId: string, quota: CodexQuota): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.cachedQuota = quota;
    entry.quotaFetchedAt = new Date().toISOString();
    this.schedulePersist();
  }

  /**
   * Mark an account as quota-exhausted by setting it rate_limited until resetAt.
   * Reuses the rate_limited mechanism so acquire() skips it and refreshStatus() auto-recovers.
   */
  markQuotaExhausted(entryId: string, resetAtUnix: number | null): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    // Don't override disabled, expired, or banned states
    if (entry.status === "disabled" || entry.status === "expired" || entry.status === "banned") return;

    const until = resetAtUnix
      ? new Date(resetAtUnix * 1000).toISOString()
      : new Date(Date.now() + 300_000).toISOString(); // fallback 5 min

    // Only extend rate_limit_until, never shorten it
    if (entry.status === "rate_limited" && entry.usage.rate_limit_until) {
      const existing = new Date(entry.usage.rate_limit_until).getTime();
      const proposed = new Date(until).getTime();
      if (proposed <= existing) return;
    }

    entry.status = "rate_limited";
    entry.usage.rate_limit_until = until;
    this.acquireLocks.delete(entryId);
    this.schedulePersist();
  }

  removeAccount(id: string): boolean {
    this.acquireLocks.delete(id);
    const deleted = this.accounts.delete(id);
    if (deleted) this.schedulePersist();
    return deleted;
  }

  /**
   * Update an account's token (used by refresh scheduler).
   */
  updateToken(entryId: string, newToken: string, refreshToken?: string | null): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    entry.token = newToken;
    if (refreshToken !== undefined) {
      entry.refreshToken = refreshToken ?? null;
    }
    const profile = extractUserProfile(newToken);
    entry.email = profile?.email ?? entry.email;
    entry.planType = profile?.chatgpt_plan_type ?? entry.planType;
    entry.accountId = extractChatGptAccountId(newToken) ?? entry.accountId;
    entry.userId = profile?.chatgpt_user_id ?? entry.userId;
    entry.status = "active";
    this.persistNow(); // Critical data — persist immediately
  }

  /** Set a user-editable label for an account. Returns false if not found. */
  setLabel(entryId: string, label: string | null): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.label = label;
    this.schedulePersist();
    return true;
  }

  markStatus(entryId: string, status: AccountEntry["status"]): void {
    this.acquireLocks.delete(entryId);
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.status = status;
    this.schedulePersist();
  }

  /** Clear rate_limited status and rate_limit_until (quota refresher confirms recovery). */
  clearRateLimit(entryId: string): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.status = "active";
    entry.usage.rate_limit_until = null;
    this.acquireLocks.delete(entryId);
    this.schedulePersist();
  }

  resetUsage(entryId: string): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.usage = {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_reset_at: entry.usage.window_reset_at ?? null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_counters_reset_at: new Date().toISOString(),
      limit_window_seconds: entry.usage.limit_window_seconds ?? null,
    };
    this.schedulePersist();
    return true;
  }

  /**
   * Check if the rate limit window has rolled over.
   * If so, auto-reset local usage counters to stay in sync.
   * Called after fetching quota from OpenAI API.
   */
  syncRateLimitWindow(
    entryId: string,
    newResetAt: number | null,
    limitWindowSeconds: number | null,
  ): void {
    if (newResetAt == null) return;
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    const oldResetAt = entry.usage.window_reset_at;
    if (oldResetAt != null && oldResetAt !== newResetAt) {
      // Codex API reset_at drifts slightly between calls (activity-based sliding window).
      // Only reset counters on a true window rollover: when reset_at jumps by a large amount
      // (at least half the window size), not just a small drift of a few hundred seconds.
      const drift = Math.abs(newResetAt - oldResetAt);
      const windowSec = limitWindowSeconds ?? entry.usage.limit_window_seconds ?? 0;
      const threshold = windowSec > 0 ? windowSec * 0.5 : 3600;
      if (drift >= threshold) {
        console.log(`[AccountPool] Rate limit window rolled for ${entryId} (${entry.email ?? "?"}), resetting window counters (drift=${drift}s, threshold=${threshold}s)`);
        entry.usage.window_request_count = 0;
        entry.usage.window_input_tokens = 0;
        entry.usage.window_output_tokens = 0;
        entry.usage.window_counters_reset_at = new Date().toISOString();
      }
    }
    entry.usage.window_reset_at = newResetAt;
    if (limitWindowSeconds != null) {
      entry.usage.limit_window_seconds = limitWindowSeconds;
    }
    this.schedulePersist();
  }

  // ── Query ───────────────────────────────────────────────────────

  getAccounts(): AccountInfo[] {
    const now = new Date();
    return [...this.accounts.values()].map((a) => {
      this.refreshStatus(a, now);
      return this.toInfo(a);
    });
  }

  getEntry(entryId: string): AccountEntry | undefined {
    return this.accounts.get(entryId);
  }

  getAllEntries(): AccountEntry[] {
    return [...this.accounts.values()];
  }

  isAuthenticated(): boolean {
    const now = new Date();
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
      if (entry.status === "active") return true;
    }
    return false;
  }

  /** @deprecated Use getAccounts() instead. */
  getUserInfo(): { email?: string; accountId?: string; planType?: string } | null {
    const first = [...this.accounts.values()].find((a) => a.status === "active");
    if (!first) return null;
    return {
      email: first.email ?? undefined,
      accountId: first.accountId ?? undefined,
      planType: first.planType ?? undefined,
    };
  }

  /** @deprecated Use getAccounts() instead. */
  getProxyApiKey(): string | null {
    const first = [...this.accounts.values()].find((a) => a.status === "active");
    return first?.proxyApiKey ?? null;
  }

  validateProxyApiKey(key: string): boolean {
    const configKey = getConfig().server.proxy_api_key;
    if (configKey && key === configKey) return true;
    for (const entry of this.accounts.values()) {
      if (entry.proxyApiKey === key) return true;
    }
    return false;
  }

  /** @deprecated Use removeAccount() instead. */
  clearToken(): void {
    this.accounts.clear();
    this.acquireLocks.clear();
    this.persistNow();
  }

  // ── Pool summary ────────────────────────────────────────────────

  getPoolSummary(): {
    total: number;
    active: number;
    expired: number;
    rate_limited: number;
    refreshing: number;
    disabled: number;
    banned: number;
  } {
    const now = new Date();
    let active = 0, expired = 0, rate_limited = 0, refreshing = 0, disabled = 0, banned = 0;
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
      switch (entry.status) {
        case "active": active++; break;
        case "expired": expired++; break;
        case "rate_limited": rate_limited++; break;
        case "refreshing": refreshing++; break;
        case "disabled": disabled++; break;
        case "banned": banned++; break;
      }
    }
    return {
      total: this.accounts.size,
      active,
      expired,
      rate_limited,
      refreshing,
      disabled,
      banned,
    };
  }

  // ── Internal ────────────────────────────────────────────────────

  private refreshStatus(entry: AccountEntry, now: Date): void {
    // Auto-recover rate-limited accounts
    if (entry.status === "rate_limited" && entry.usage.rate_limit_until) {
      if (now >= new Date(entry.usage.rate_limit_until)) {
        entry.status = "active";
        entry.usage.rate_limit_until = null;
      }
    }

    // Mark expired tokens
    if (entry.status === "active" && isTokenExpired(entry.token)) {
      entry.status = "expired";
    }

    // Auto-reset window counters when window has expired
    const windowResetAt = entry.usage.window_reset_at;
    const nowSec = now.getTime() / 1000;
    if (windowResetAt != null && nowSec >= windowResetAt) {
      console.log(`[AccountPool] Window expired for ${entry.id} (${entry.email ?? "?"}), resetting window counters`);
      entry.usage.window_request_count = 0;
      entry.usage.window_input_tokens = 0;
      entry.usage.window_output_tokens = 0;
      entry.usage.window_counters_reset_at = now.toISOString();
      // Jump to the correct current window (handles multi-window catch-up in one step)
      const windowSec = entry.usage.limit_window_seconds;
      if (windowSec && windowSec > 0) {
        let nextReset = windowResetAt + windowSec;
        while (nextReset <= nowSec) nextReset += windowSec;
        entry.usage.window_reset_at = nextReset;
      } else {
        entry.usage.window_reset_at = null; // Wait for backend sync to correct
      }
      this.schedulePersist();
    }
  }

  private toInfo(entry: AccountEntry): AccountInfo {
    const payload = decodeJwtPayload(entry.token);
    const exp = payload?.exp;
    const info: AccountInfo = {
      id: entry.id,
      email: entry.email,
      accountId: entry.accountId,
      userId: entry.userId,
      label: entry.label,
      planType: entry.planType,
      status: entry.status,
      usage: { ...entry.usage },
      addedAt: entry.addedAt,
      expiresAt:
        typeof exp === "number"
          ? new Date(exp * 1000).toISOString()
          : null,
    };
    if (entry.cachedQuota) {
      info.quota = entry.cachedQuota;
      info.quotaFetchedAt = entry.quotaFetchedAt;
    }
    return info;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 1000);
  }

  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistence.save([...this.accounts.values()]);
  }

  /** Flush pending writes on shutdown */
  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }
}
