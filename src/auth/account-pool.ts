/**
 * AccountPool — multi-account manager with least-used rotation.
 * Replaces the single-account AuthManager.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getConfig } from "../config.js";
import { jitter } from "../utils/jitter.js";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import type {
  AccountEntry,
  AccountInfo,
  AccountUsage,
  AcquiredAccount,
  AccountsFile,
} from "./types.js";

const ACCOUNTS_FILE = resolve(process.cwd(), "data", "accounts.json");
const LEGACY_AUTH_FILE = resolve(process.cwd(), "data", "auth.json");

// P1-4: Lock TTL — auto-release locks older than this
const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class AccountPool {
  private accounts: Map<string, AccountEntry> = new Map();
  private acquireLocks: Map<string, number> = new Map(); // entryId → timestamp
  private roundRobinIndex = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.migrateFromLegacy();
    this.loadPersisted();

    // Override with config jwt_token if set
    const config = getConfig();
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
   */
  acquire(): AcquiredAccount | null {
    const config = getConfig();
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

    // Filter available accounts
    const available = [...this.accounts.values()].filter(
      (a) => a.status === "active" && !this.acquireLocks.has(a.id),
    );

    if (available.length === 0) return null;

    let selected: AccountEntry;
    if (config.auth.rotation_strategy === "round_robin") {
      this.roundRobinIndex = this.roundRobinIndex % available.length;
      selected = available[this.roundRobinIndex];
      this.roundRobinIndex++;
    } else {
      // least_used: sort by request_count asc, then by last_used asc (LRU)
      available.sort((a, b) => {
        const diff = a.usage.request_count - b.usage.request_count;
        if (diff !== 0) return diff;
        const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
        const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
        return aTime - bTime;
      });
      selected = available[0];
    }

    this.acquireLocks.set(selected.id, Date.now());
    return {
      entryId: selected.id,
      token: selected.token,
      accountId: selected.accountId,
    };
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
    this.schedulePersist();
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

    // Deduplicate by accountId
    if (accountId) {
      for (const existing of this.accounts.values()) {
        if (existing.accountId === accountId) {
          // Update the existing entry's token
          existing.token = token;
          if (refreshToken !== undefined) {
            existing.refreshToken = refreshToken ?? null;
          }
          existing.email = profile?.email ?? existing.email;
          existing.planType = profile?.chatgpt_plan_type ?? existing.planType;
          existing.status = isTokenExpired(token) ? "expired" : "active";
          this.persistNow(); // Critical data — persist immediately
          return existing.id;
        }
      }
    }

    const id = randomBytes(8).toString("hex");
    const entry: AccountEntry = {
      id,
      token,
      refreshToken: refreshToken ?? null,
      email: profile?.email ?? null,
      accountId,
      planType: profile?.chatgpt_plan_type ?? null,
      proxyApiKey: "codex-proxy-" + randomBytes(24).toString("hex"),
      status: isTokenExpired(token) ? "expired" : "active",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        last_used: null,
        rate_limit_until: null,
      },
      addedAt: new Date().toISOString(),
    };

    this.accounts.set(id, entry);
    this.persistNow(); // Critical data — persist immediately
    return id;
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
    entry.status = "active";
    this.persistNow(); // Critical data — persist immediately
  }

  markStatus(entryId: string, status: AccountEntry["status"]): void {
    const entry = this.accounts.get(entryId);
    if (!entry) return;
    entry.status = status;
    this.schedulePersist();
  }

  resetUsage(entryId: string): boolean {
    const entry = this.accounts.get(entryId);
    if (!entry) return false;
    entry.usage = {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      last_used: null,
      rate_limit_until: null,
      window_reset_at: entry.usage.window_reset_at ?? null,
    };
    this.schedulePersist();
    return true;
  }

  /**
   * Check if the rate limit window has rolled over.
   * If so, auto-reset local usage counters to stay in sync.
   * Called after fetching quota from OpenAI API.
   */
  syncRateLimitWindow(entryId: string, newResetAt: number | null): void {
    if (newResetAt == null) return;
    const entry = this.accounts.get(entryId);
    if (!entry) return;

    const oldResetAt = entry.usage.window_reset_at;
    if (oldResetAt != null && oldResetAt !== newResetAt) {
      // Window rolled over — reset local counters
      console.log(`[AccountPool] Rate limit window rolled for ${entryId} (${entry.email ?? "?"}), resetting usage counters`);
      entry.usage.request_count = 0;
      entry.usage.input_tokens = 0;
      entry.usage.output_tokens = 0;
      entry.usage.last_used = null;
      entry.usage.rate_limit_until = null;
    }
    entry.usage.window_reset_at = newResetAt;
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
  } {
    const now = new Date();
    let active = 0, expired = 0, rate_limited = 0, refreshing = 0, disabled = 0;
    for (const entry of this.accounts.values()) {
      this.refreshStatus(entry, now);
      switch (entry.status) {
        case "active": active++; break;
        case "expired": expired++; break;
        case "rate_limited": rate_limited++; break;
        case "refreshing": refreshing++; break;
        case "disabled": disabled++; break;
      }
    }
    return {
      total: this.accounts.size,
      active,
      expired,
      rate_limited,
      refreshing,
      disabled,
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
  }

  private toInfo(entry: AccountEntry): AccountInfo {
    const payload = decodeJwtPayload(entry.token);
    const exp = payload?.exp;
    return {
      id: entry.id,
      email: entry.email,
      accountId: entry.accountId,
      planType: entry.planType,
      status: entry.status,
      usage: { ...entry.usage },
      addedAt: entry.addedAt,
      expiresAt:
        typeof exp === "number"
          ? new Date(exp * 1000).toISOString()
          : null,
    };
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
    try {
      const dir = dirname(ACCOUNTS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: AccountsFile = { accounts: [...this.accounts.values()] };
      const tmpFile = ACCOUNTS_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpFile, ACCOUNTS_FILE);
    } catch (err) {
      console.error("[AccountPool] Failed to persist accounts:", err instanceof Error ? err.message : err);
    }
  }

  private loadPersisted(): void {
    try {
      if (!existsSync(ACCOUNTS_FILE)) return;
      const raw = readFileSync(ACCOUNTS_FILE, "utf-8");
      const data = JSON.parse(raw) as AccountsFile;
      if (Array.isArray(data.accounts)) {
        let needsPersist = false;
        for (const entry of data.accounts) {
          if (entry.id && entry.token) {
            // Backfill missing fields from JWT (e.g. planType was null before fix)
            if (!entry.planType || !entry.email || !entry.accountId) {
              const profile = extractUserProfile(entry.token);
              const accountId = extractChatGptAccountId(entry.token);
              if (!entry.planType && profile?.chatgpt_plan_type) {
                entry.planType = profile.chatgpt_plan_type;
                needsPersist = true;
              }
              if (!entry.email && profile?.email) {
                entry.email = profile.email;
                needsPersist = true;
              }
              if (!entry.accountId && accountId) {
                entry.accountId = accountId;
                needsPersist = true;
              }
            }
            this.accounts.set(entry.id, entry);
          }
        }
        if (needsPersist) this.persistNow();
      }
    } catch (err) {
      console.warn("[AccountPool] Failed to load accounts:", err instanceof Error ? err.message : err);
    }
  }

  private migrateFromLegacy(): void {
    try {
      if (existsSync(ACCOUNTS_FILE)) return; // already migrated
      if (!existsSync(LEGACY_AUTH_FILE)) return;

      const raw = readFileSync(LEGACY_AUTH_FILE, "utf-8");
      const data = JSON.parse(raw) as {
        token: string;
        proxyApiKey?: string | null;
        userInfo?: { email?: string; accountId?: string; planType?: string } | null;
      };

      if (!data.token) return;

      const id = randomBytes(8).toString("hex");
      const accountId = extractChatGptAccountId(data.token);
      const entry: AccountEntry = {
        id,
        token: data.token,
        refreshToken: null,
        email: data.userInfo?.email ?? null,
        accountId: accountId,
        planType: data.userInfo?.planType ?? null,
        proxyApiKey: data.proxyApiKey ?? "codex-proxy-" + randomBytes(24).toString("hex"),
        status: isTokenExpired(data.token) ? "expired" : "active",
        usage: {
          request_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          last_used: null,
          rate_limit_until: null,
        },
        addedAt: new Date().toISOString(),
      };

      this.accounts.set(id, entry);

      // Write new format
      const dir = dirname(ACCOUNTS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const accountsData: AccountsFile = { accounts: [entry] };
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), "utf-8");

      // Rename old file
      renameSync(LEGACY_AUTH_FILE, LEGACY_AUTH_FILE + ".bak");
      console.log("[AccountPool] Migrated from auth.json → accounts.json");
    } catch (err) {
      console.warn("[AccountPool] Migration failed:", err);
    }
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
