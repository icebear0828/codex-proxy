/**
 * AccountImportService — token validation + account creation orchestration.
 * Extracted from routes/accounts.ts (Phase 3).
 */

import type { AccountPool } from "../auth/account-pool.js";
import type { AccountInfo } from "../auth/types.js";
import { extractChatGptAccountId } from "../auth/jwt-utils.js";

export interface ImportEntry {
  token?: string;
  refreshToken?: string | null;
  label?: string | null;
}

export interface ImportResult {
  added: number;
  updated: number;
  failed: number;
  errors: string[];
}

export type ImportOneResult =
  | { ok: true; entryId: string; account: AccountInfo }
  | { ok: false; error: string; kind: "validation" | "refresh_failed" };

/** Injected dependencies — keeps the service testable without vi.mock. */
export interface ImportDeps {
  validateToken(token: string): { valid: boolean; error?: string };
  refreshToken(
    rt: string,
    proxyUrl: string | null,
  ): Promise<{ access_token: string; refresh_token?: string }>;
  getProxyUrl(): string | null;
  /** Optional warmup: establishes session cookies after import to avoid cold-start bans. */
  warmup?(entryId: string, token: string, accountId: string | null): Promise<void>;
  /** Optional verify: checks if the account is usable and returns usage data. Only used for single imports. */
  verifyAccount?(token: string, accountId: string | null, proxyUrl: string | null): Promise<{
    ok: boolean;
    error?: string;
    /** Raw usage response for caching quota on success. */
    usage?: import("../proxy/codex-api.js").CodexUsageResponse;
  }>;
}

export class AccountImportService {
  /** Tracks RTs currently being refreshed to prevent concurrent consumption. */
  private refreshingRTs = new Set<string>();

  constructor(
    private pool: AccountPool,
    private scheduler: { scheduleOne(entryId: string, token: string): void },
    private deps: ImportDeps,
  ) {}

  async importMany(entries: ImportEntry[]): Promise<ImportResult> {
    let added = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];
    const existingIds = new Set(this.pool.getAccounts().map((a) => a.id));

    for (const entry of entries) {
      const resolved = await this.resolveToken(
        entry.token,
        entry.refreshToken ?? null,
      );
      if (!resolved.ok) {
        failed++;
        errors.push(resolved.error);
        continue;
      }

      const entryId = this.pool.addAccount(resolved.token, resolved.rt);
      this.scheduler.scheduleOne(entryId, resolved.token);

      if (entry.label) {
        this.pool.setLabel(entryId, entry.label);
      }

      // Warmup: establish session cookies to avoid cold-start detection
      if (this.deps.warmup) {
        const accountId = extractChatGptAccountId(resolved.token);
        try {
          await this.deps.warmup(entryId, resolved.token, accountId);
        } catch (err) {
          console.warn(`[Import] Warmup failed for ${entryId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (existingIds.has(entryId)) {
        updated++;
      } else {
        added++;
        existingIds.add(entryId);
      }
    }

    return { added, updated, failed, errors };
  }

  async importOne(
    token?: string,
    refreshToken?: string,
  ): Promise<ImportOneResult> {
    if (!token && !refreshToken) {
      return {
        ok: false,
        error: "Either token or refreshToken is required",
        kind: "validation",
      };
    }

    const resolved = await this.resolveToken(token, refreshToken ?? null);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error, kind: resolved.kind };
    }

    // Single import: verify account is usable and collect quota.
    // Skip verification for RT-only imports — calling getUsage() immediately
    // after RT exchange triggers OpenAI risk detection (same reason warmup is disabled).
    const wasRtExchange = !token && !!refreshToken;
    let usageData: import("../proxy/codex-api.js").CodexUsageResponse | undefined;
    if (this.deps.verifyAccount && !wasRtExchange) {
      const accountId = extractChatGptAccountId(resolved.token);
      const proxyUrl = this.deps.getProxyUrl();
      try {
        const check = await this.deps.verifyAccount(resolved.token, accountId, proxyUrl);
        if (!check.ok) {
          return { ok: false, error: check.error ?? "Account verification failed", kind: "validation" };
        }
        usageData = check.usage;
      } catch (err) {
        return {
          ok: false,
          error: `Account verification failed: ${err instanceof Error ? err.message : String(err)}`,
          kind: "validation",
        };
      }
    }

    const entryId = this.pool.addAccount(resolved.token, resolved.rt);
    this.scheduler.scheduleOne(entryId, resolved.token);

    // Cache quota from verification (so dashboard shows data immediately)
    if (usageData) {
      const { toQuota } = await import("../auth/quota-utils.js");
      this.pool.updateCachedQuota(entryId, toQuota(usageData));
    }

    const account = this.pool.getAccounts().find((a) => a.id === entryId);
    if (!account) {
      return { ok: false, error: "Failed to add account", kind: "validation" };
    }

    return { ok: true, entryId, account };
  }

  /** Validate or exchange a token, returning the resolved access token + refresh token. */
  private async resolveToken(
    token: string | undefined,
    rt: string | null,
  ): Promise<
    | { ok: true; token: string; rt: string | null }
    | { ok: false; error: string; kind: "validation" | "refresh_failed" }
  > {
    if (token) {
      const v = this.deps.validateToken(token);
      if (!v.valid) {
        return { ok: false, error: v.error ?? "Invalid token", kind: "validation" };
      }
      return { ok: true, token, rt };
    }

    // Refresh-token-only path — check if this RT already belongs to an existing account
    const existing = this.pool.getAllEntries().find((a) => a.refreshToken === rt);
    if (existing) {
      return { ok: true, token: existing.token, rt: existing.refreshToken };
    }

    // Prevent concurrent refresh of the same RT (e.g. duplicate entries in import file)
    if (this.refreshingRTs.has(rt as string)) {
      return { ok: false, error: "Duplicate RT in import batch (skipped to protect token)", kind: "refresh_failed" };
    }
    this.refreshingRTs.add(rt as string);

    try {
      const proxyUrl = this.deps.getProxyUrl();
      const tokens = await this.deps.refreshToken(rt as string, proxyUrl);
      const v = this.deps.validateToken(tokens.access_token);
      if (!v.valid) {
        return {
          ok: false,
          error: `Refresh token exchange succeeded but token invalid: ${v.error}`,
          kind: "validation",
        };
      }
      // All OpenAI RTs are single-use — if server doesn't return a new one, the old one is consumed/dead
      const newRT = tokens.refresh_token ?? null;
      return {
        ok: true,
        token: tokens.access_token,
        rt: newRT,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Refresh token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "refresh_failed",
      };
    } finally {
      this.refreshingRTs.delete(rt as string);
    }
  }
}
