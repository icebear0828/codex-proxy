/**
 * AccountQueryService — list, enrich, and export accounts.
 * Extracted from routes/accounts.ts (Phase 3).
 */

import type { AccountPool } from "../auth/account-pool.js";
import type { AccountEntry, AccountInfo, CodexQuota } from "../auth/types.js";
import type { CodexUsageResponse } from "../proxy/codex-types.js";
import { toQuota } from "../auth/quota-utils.js";
import { isBanError, isTokenInvalidError } from "../proxy/error-classification.js";

export type EnrichedAccountInfo = AccountInfo & {
  proxyId: string;
  proxyName: string;
  quota?: CodexQuota;
};

export interface ProxyResolver {
  getAssignment(accountId: string): string;
  getAssignmentDisplayName(accountId: string): string;
}

export interface UsageFetcher {
  fetchUsage(
    entryId: string,
    token: string,
    accountId: string | null,
  ): Promise<CodexUsageResponse>;
}

export class AccountQueryService {
  constructor(
    private pool: AccountPool,
    private proxyResolver?: ProxyResolver,
    private usageFetcher?: UsageFetcher,
  ) {}

  listCached(): EnrichedAccountInfo[] {
    return this.pool.getAccounts().map((acct) => this.enrich(acct));
  }

  async listFresh(): Promise<EnrichedAccountInfo[]> {
    const accounts = this.pool.getAccounts();
    return Promise.all(
      accounts.map(async (acct) => {
        if (acct.status !== "active") return this.enrich(acct);

        const entry = this.pool.getEntry(acct.id);
        if (!entry || !this.usageFetcher) return this.enrich(acct);

        try {
          const usage = await this.usageFetcher.fetchUsage(
            acct.id,
            entry.token,
            entry.accountId,
          );
          const quota = toQuota(usage);
          this.pool.updateCachedQuota(acct.id, quota);

          const resetAt =
            usage.rate_limit.primary_window?.reset_at ?? null;
          const windowSec =
            usage.rate_limit.primary_window?.limit_window_seconds ?? null;
          this.pool.syncRateLimitWindow(acct.id, resetAt, windowSec);

          // Re-read after potential counter reset
          const freshAcct =
            this.pool.getAccounts().find((a) => a.id === acct.id) ?? acct;
          return { ...this.enrich(freshAcct), quota };
        } catch (err) {
          if (isTokenInvalidError(err)) {
            this.pool.markStatus(acct.id, "expired");
          } else if (isBanError(err)) {
            this.pool.markStatus(acct.id, "banned");
          }
          return this.enrich(acct);
        }
      }),
    );
  }

  exportFull(ids?: string[]): AccountEntry[] {
    let entries = this.pool.getAllEntries();
    if (ids) {
      const idSet = new Set(ids);
      entries = entries.filter((e) => idSet.has(e.id));
    }
    return entries;
  }

  exportMinimal(
    ids?: string[],
  ): Array<{ refreshToken: string; label?: string }> {
    let entries = this.pool.getAllEntries();
    if (ids) {
      const idSet = new Set(ids);
      entries = entries.filter((e) => idSet.has(e.id));
    }
    return entries
      .filter((e) => e.refreshToken)
      .map((e) => {
        const item: { refreshToken: string; label?: string } = {
          refreshToken: e.refreshToken!,
        };
        if (e.label) item.label = e.label;
        return item;
      });
  }

  private enrich(acct: AccountInfo): EnrichedAccountInfo {
    return {
      ...acct,
      proxyId: this.proxyResolver?.getAssignment(acct.id) ?? "global",
      proxyName:
        this.proxyResolver?.getAssignmentDisplayName(acct.id) ??
        "Global Default",
    };
  }
}
