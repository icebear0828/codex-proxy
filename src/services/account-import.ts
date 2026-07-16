/**
 * AccountImportService — token validation + account creation orchestration.
 * Extracted from routes/accounts.ts (Phase 3).
 */

import type { AccountPool } from "../auth/account-pool.js";
import type { AccountInfo } from "../auth/types.js";
import { validateTokenStructure } from "../auth/chatgpt-oauth.js";
import {
  extractCodexTokenMetadata,
  type CodexTokenMetadata,
} from "../auth/token-metadata.js";

export interface ImportEntry {
  token?: string;
  refreshToken?: string | null;
  idToken?: string | null;
  label?: string | null;
  accountIdHint?: string | null;
  organizationId?: string | null;
  userIdHint?: string | null;
  emailHint?: string | null;
  planTypeHint?: string | null;
  sourceFormat?: "sub2api" | "generic";
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

function redactImportError(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(/\b(?:oaistb_rt_|rt_)[A-Za-z0-9._-]{8,}/g, "[REDACTED_REFRESH_TOKEN]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

/** Injected dependencies — keeps the service testable without vi.mock. */
export interface ImportDeps {
  validateToken(token: string): { valid: boolean; error?: string };
  refreshToken(
    rt: string,
    proxyUrl: string | null,
  ): Promise<{ access_token: string; refresh_token?: string; id_token?: string }>;
  getProxyUrl(): string | null;
  /** Resolve the real workspace ID for structurally valid accountId-less tokens. */
  discoverIdentity?(
    token: string,
    metadata: CodexTokenMetadata,
    options: { accountIdHint?: string | null; proxyUrl: string | null },
  ): Promise<CodexTokenMetadata>;
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
    return this.pool.withPersistenceBatch(async () => {
      let added = 0;
      let updated = 0;
      let failed = 0;
      const errors: string[] = [];
      const existingIds = new Set(this.pool.getAccounts().map((a) => a.id));

      for (const entry of entries) {
        const resolved = await this.resolveToken(entry);
        if (!resolved.ok) {
          failed++;
          errors.push(redactImportError(resolved.error));
          continue;
        }

        const entryId = this.pool.addAccount(
          resolved.token,
          resolved.rt,
          resolved.metadata,
        );
        this.scheduler.scheduleOne(entryId, resolved.token);

        if (entry.label) {
          this.pool.setLabel(entryId, entry.label);
        }

        // Warmup: establish session cookies to avoid cold-start detection
        if (this.deps.warmup) {
          try {
            await this.deps.warmup(
              entryId,
              resolved.token,
              resolved.metadata.accountId,
            );
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
    });
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

    const resolved = await this.resolveToken({
      token,
      refreshToken: refreshToken ?? null,
      sourceFormat: "generic",
    });
    if (!resolved.ok) {
      return {
        ok: false,
        error: redactImportError(resolved.error),
        kind: resolved.kind,
      };
    }

    // Single import: verify account is usable and collect quota.
    // Skip verification for RT-only imports — calling getUsage() immediately
    // after RT exchange triggers OpenAI risk detection (same reason warmup is disabled).
    const wasRtExchange = !token && !!refreshToken;
    let usageData: import("../proxy/codex-api.js").CodexUsageResponse | undefined;
    if (this.deps.verifyAccount && !wasRtExchange) {
      const proxyUrl = this.deps.getProxyUrl();
      try {
        const check = await this.deps.verifyAccount(
          resolved.token,
          resolved.metadata.accountId,
          proxyUrl,
        );
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

    const entryId = this.pool.addAccount(
      resolved.token,
      resolved.rt,
      resolved.metadata,
    );
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

  /** Validate or exchange a token, returning tokens plus resolved identity metadata. */
  private async resolveToken(
    entry: ImportEntry,
  ): Promise<
    | { ok: true; token: string; rt: string | null; metadata: CodexTokenMetadata }
    | { ok: false; error: string; kind: "validation" | "refresh_failed" }
  > {
    const token = entry.token?.trim();
    const rt = entry.refreshToken?.trim() || null;
    const metadataHints = {
      organizationId: entry.organizationId,
      userId: entry.userIdHint,
      email: entry.emailHint,
      planType: entry.planTypeHint,
    };

    if (token) {
      let metadata = extractCodexTokenMetadata(
        token,
        entry.idToken,
        metadataHints,
      );
      // A file-supplied id_token is decoded but not signature-verified. Treat
      // its workspace ID only as a discovery hint; the upstream account-check
      // response must confirm it before it can control ChatGPT-Account-Id.
      const idTokenAccountIdHint = metadata.accountIdSource === "id_token"
        ? metadata.accountId
        : null;
      if (idTokenAccountIdHint) {
        metadata = {
          ...metadata,
          accountId: null,
          accountIdSource: null,
        };
      }
      const strict = this.deps.validateToken(token);
      if (strict.valid) {
        return { ok: true, token, rt, metadata };
      }

      // Do not rely on a mutable error string. A token that passes the
      // structural contract but has no token-derived account ID is the one
      // recoverable compatibility case; all other validation failures remain fatal.
      const structure = validateTokenStructure(token);
      if (!structure.valid) {
        return {
          ok: false,
          error: strict.error ?? structure.error ?? "Invalid token",
          kind: "validation",
        };
      }

      if (metadata.accountId) {
        return {
          ok: false,
          error: strict.error ?? "Invalid token",
          kind: "validation",
        };
      }

      if (!this.deps.discoverIdentity) {
        return {
          ok: false,
          error: "Token is valid but missing chatgpt_account_id and identity discovery is unavailable",
          kind: "validation",
        };
      }

      try {
        metadata = await this.deps.discoverIdentity(token, metadata, {
          accountIdHint: entry.accountIdHint ?? idTokenAccountIdHint,
          proxyUrl: this.deps.getProxyUrl(),
        });
      } catch (err) {
        return {
          ok: false,
          error: `Account identity discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          kind: "validation",
        };
      }
      if (!metadata.accountId) {
        return {
          ok: false,
          error: "Account identity discovery returned no workspace account ID",
          kind: "validation",
        };
      }
      return { ok: true, token, rt, metadata };
    }

    if (!rt) {
      return {
        ok: false,
        error: "Either token or refreshToken is required",
        kind: "validation",
      };
    }

    // Refresh-token-only path — check if this RT already belongs to an existing account
    const existing = this.pool.getAllEntries().find((a) => a.refreshToken === rt);
    if (existing) {
      return {
        ok: true,
        token: existing.token,
        rt: existing.refreshToken,
        metadata: {
          accountId: existing.accountId,
          organizationId: existing.organizationId ?? null,
          userId: existing.userId,
          email: existing.email,
          planType: existing.planType,
          accountIdSource: existing.accountIdSource ?? null,
        },
      };
    }

    // Prevent concurrent refresh of the same RT (e.g. duplicate entries in import file)
    if (this.refreshingRTs.has(rt)) {
      return { ok: false, error: "Duplicate RT in import batch (skipped to protect token)", kind: "refresh_failed" };
    }
    this.refreshingRTs.add(rt);

    try {
      const proxyUrl = this.deps.getProxyUrl();
      const tokens = await this.deps.refreshToken(rt, proxyUrl);
      const accessToken = tokens.access_token.trim();
      const structure = validateTokenStructure(accessToken);
      if (!structure.valid) {
        return {
          ok: false,
          error: `Refresh token exchange succeeded but token invalid: ${structure.error}`,
          kind: "validation",
        };
      }
      // Do not immediately probe quota/account-check after an RT exchange: the
      // existing risk controls intentionally avoid that cold-start sequence.
      // File-supplied id_token values are portable metadata only: they are not
      // signature-verified and must never become an authoritative workspace ID.
      // Decode them first for non-routing hints, then extract authoritative
      // accountId only from the exchanged access token or the token endpoint's
      // fresh id_token response.
      const portableMetadata = extractCodexTokenMetadata(
        accessToken,
        entry.idToken,
        metadataHints,
      );
      const metadata = extractCodexTokenMetadata(
        accessToken,
        tokens.id_token,
        {
          organizationId: portableMetadata.organizationId,
          userId: portableMetadata.userId,
          email: portableMetadata.email,
          planType: portableMetadata.planType,
        },
      );
      // All OpenAI RTs are single-use — if server doesn't return a new one, the old one is consumed/dead
      const newRT = tokens.refresh_token ?? null;
      return {
        ok: true,
        token: accessToken,
        rt: newRT,
        metadata,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Refresh token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
        kind: "refresh_failed",
      };
    } finally {
      this.refreshingRTs.delete(rt);
    }
  }
}
