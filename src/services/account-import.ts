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
  label?: string;
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
}

export class AccountImportService {
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

    const entryId = this.pool.addAccount(resolved.token, resolved.rt);
    this.scheduler.scheduleOne(entryId, resolved.token);

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

    // Refresh-token-only path
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
      // oaistb_rt_ tokens are single-use — if no new RT returned, the old one is dead
      const isOneTimeRT = rt?.startsWith("oaistb_rt_");
      const newRT = tokens.refresh_token ?? (isOneTimeRT ? null : rt);
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
    }
  }
}
