/**
 * AccountRegistry — owns the Map<string, AccountEntry> and persistence.
 *
 * Handles: CRUD, queries, status mutations, and auto-status refresh.
 * Does NOT own acquire locks (that's AccountLifecycle's concern).
 */

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { jitter } from "../utils/jitter.js";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import type { AccountPersistence } from "./account-persistence.js";
import type {
  AccountEntry,
  AccountInfo,
  CodexQuota,
} from "./types.js";

export class AccountRegistry {
  private accounts: Map<string, AccountEntry> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistence: AccountPersistence;

  constructor(persistence: AccountPersistence, initialEntries: AccountEntry[]) {
    this.persistence = persistence;
    for (const entry of initialEntries) {
      this.accounts.set(entry.id, entry);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  addAccount(token: string, refreshToken?: string | null): string {
    const accountId = extractChatGptAccountId(token);
    const profile = extractUserProfile(token);
    const userId = profile?.chatgpt_user_id ?? null;

    for (const existing of this.accounts.values()) {
      if (accountId) {
        if (existing.accountId === accountId && existing.userId === userId) {
          existing.token = token;
          if (typeof refreshToken === "string" && refreshToken.length > 0) {
            existing.refreshToken = refreshToken;
          }
          existing.email = profile?.email ?? existing.email;
          existing.planType = profile?.chatgpt_plan_type ?? existing.planType;
          existing.status = isTokenExpired(token) ? "expired" : "active";
          this.persistNow();
          return existing.id;
        }
      } else if (existing.token === token) {
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
    this.persistNow();
    return id;
  }

  removeAccount(id: string): boolean {
    const deleted = this.accounts.delete(id);
    if (deleted) this.schedulePersist();
    return deleted;
  }

  updateToken(entryId: string, newToken: string, refreshToken?: string): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    entry.token = newToken;
    // Never clear an existing RT — only replace with a new non-empty value
    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      entry.refreshToken = refreshToken;
    }
    const profile = extractUserProfile(newToken);
    entry.email = profile?.email ?? entry.email;
    entry.planType = profile?.chatgpt_plan_type ?? entry.planType;
    entry.accountId = extractChatGptAccountId(newToken) ?? entry.accountId;
    entry.userId = profile?.chatgpt_user_id ?? entry.userId;
    // Don't reactivate manually disabled or banned accounts
    if (entry.status !== "disabled" && entry.status !== "banned") {
      entry.status = isTokenExpired(newToken) ? "expired" : "active";
    }
    this.persistNow();
  }

  /**
   * Read a single account's RT from the persisted file on disk.
   * Used to detect cross-process updates before consuming a one-time RT.
   */
  readEntryRTFromDisk(entryId: string): string | null {
    try {
      const raw = readFileSync(resolve(getDataDir(), "accounts.json"), "utf-8");
      const data = JSON.parse(raw) as { accounts?: Array<{ id: string; refreshToken?: string | null }> };
      const entry = data.accounts?.find((a) => a.id === entryId);
      return entry?.refreshToken ?? null;
    } catch {
      return null;
    }
  }

  setLabel(entryId: string, label: string | null): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.label = label;
    this.schedulePersist();
    return true;
  }

  // ── Status mutations ──────────────────────────────────────────────

  /** Returns true if the entry was found and mutated. */
  markStatus(entryId: string, status: AccountEntry["status"]): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.status = status;
    this.schedulePersist();
    return true;
  }

  /** Returns true if the entry was found and mutated. */
  markRateLimited(
    entryId: string,
    backoffSeconds: number,
    options?: { retryAfterSec?: number; countRequest?: boolean },
  ): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;

    const backoff = jitter(options?.retryAfterSec ?? backoffSeconds, 0.2);
    const until = new Date(Date.now() + backoff * 1000);

    entry.status = "rate_limited";
    entry.usage.rate_limit_until = until.toISOString();

    if (options?.countRequest) {
      entry.usage.request_count++;
      entry.usage.last_used = new Date().toISOString();
      entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    }

    this.schedulePersist();
    return true;
  }

  /** Returns true if the entry was found and mutated. */
  clearRateLimit(entryId: string): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.status = "active";
    entry.usage.rate_limit_until = null;
    this.schedulePersist();
    return true;
  }

  /** Returns true if the entry was found and actually changed. */
  markQuotaExhausted(entryId: string, resetAtUnix: number | null): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    if (entry.status === "disabled" || entry.status === "expired" || entry.status === "banned" || entry.status === "refreshing") return false;

    const until = resetAtUnix
      ? new Date(resetAtUnix * 1000).toISOString()
      : new Date(Date.now() + 300_000).toISOString();

    if (entry.status === "rate_limited" && entry.usage.rate_limit_until) {
      const existing = new Date(entry.usage.rate_limit_until).getTime();
      const proposed = new Date(until).getTime();
      if (proposed <= existing) return false;
    }

    entry.status = "rate_limited";
    entry.usage.rate_limit_until = until;
    this.schedulePersist();
    return true;
  }

  // ── Query ─────────────────────────────────────────────────────────

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

  get size(): number {
    return this.accounts.size;
  }

  isAuthenticated(): boolean {
    const now = new Date();
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
      if (entry.status === "active") return true;
    }
    return false;
  }

  getUserInfo(): { email?: string; accountId?: string; planType?: string } | null {
    const first = [...this.accounts.values()].find((a) => a.status === "active");
    if (!first) return null;
    return {
      email: first.email ?? undefined,
      accountId: first.accountId ?? undefined,
      planType: first.planType ?? undefined,
    };
  }

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

  clearToken(): void {
    this.accounts.clear();
    this.persistNow();
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
    const now = new Date();
    let active = 0, expired = 0, quota_exhausted = 0, rate_limited = 0, refreshing = 0, disabled = 0, banned = 0;
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
      switch (entry.status) {
        case "active": active++; break;
        case "expired": expired++; break;
        case "quota_exhausted": quota_exhausted++; break;
        case "rate_limited": rate_limited++; break;
        case "refreshing": refreshing++; break;
        case "disabled": disabled++; break;
        case "banned": banned++; break;
      }
    }
    return { total: this.accounts.size, active, expired, quota_exhausted, rate_limited, refreshing, disabled, banned };
  }

  // ── Quota / usage mutations ───────────────────────────────────────

  /** Record request usage on release (called by lifecycle). */
  recordUsage(entryId: string, usage?: { input_tokens?: number; output_tokens?: number }): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    entry.usage.request_count++;
    entry.usage.last_used = new Date().toISOString();
    if (usage) {
      entry.usage.input_tokens += usage.input_tokens ?? 0;
      entry.usage.output_tokens += usage.output_tokens ?? 0;
    }
    entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    if (usage) {
      entry.usage.window_input_tokens = (entry.usage.window_input_tokens ?? 0) + (usage.input_tokens ?? 0);
      entry.usage.window_output_tokens = (entry.usage.window_output_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    this.schedulePersist();
  }

  recordEmptyResponse(entryId: string): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.usage.empty_response_count++;
    this.schedulePersist();
  }

  updateCachedQuota(entryId: string, quota: CodexQuota): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.cachedQuota = quota;
    entry.quotaFetchedAt = new Date().toISOString();
    this.schedulePersist();
  }

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

  // ── Internal ──────────────────────────────────────────────────────

  refreshStatus(entry: AccountEntry, now: Date): void {
    if (entry.status === "rate_limited" && entry.usage.rate_limit_until) {
      if (now >= new Date(entry.usage.rate_limit_until)) {
        entry.status = "active";
        entry.usage.rate_limit_until = null;
      }
    }

    if (entry.status === "active" && isTokenExpired(entry.token)) {
      entry.status = "expired";
    }

    const windowResetAt = entry.usage.window_reset_at;
    const nowSec = now.getTime() / 1000;
    if (windowResetAt != null && nowSec >= windowResetAt) {
      console.log(`[AccountPool] Window expired for ${entry.id} (${entry.email ?? "?"}), resetting window counters`);
      entry.usage.window_request_count = 0;
      entry.usage.window_input_tokens = 0;
      entry.usage.window_output_tokens = 0;
      entry.usage.window_counters_reset_at = now.toISOString();
      const windowSec = entry.usage.limit_window_seconds;
      if (windowSec && windowSec > 0) {
        let nextReset = windowResetAt + windowSec;
        while (nextReset <= nowSec) nextReset += windowSec;
        entry.usage.window_reset_at = nextReset;
      } else {
        entry.usage.window_reset_at = null;
      }
      this.schedulePersist();
    }

    // Clear stale cached quota when its own reset time has passed
    const quotaReset = entry.cachedQuota?.rate_limit?.reset_at;
    if (quotaReset != null && nowSec >= quotaReset) {
      entry.cachedQuota = null;
      entry.quotaFetchedAt = null;
      this.schedulePersist();
    }
  }

  toInfo(entry: AccountEntry): AccountInfo {
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

  // ── Persistence ───────────────────────────────────────────────────

  schedulePersist(): void {
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

  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }
}
