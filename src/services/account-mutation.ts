/**
 * AccountMutationService — batch delete and status changes.
 * Extracted from routes/accounts.ts (Phase 3).
 */

import type { AccountPool } from "../auth/account-pool.js";
import { resetCfPathBlock } from "../auth/cf-path-block-tracker.js";

export interface DeleteResult {
  deleted: number;
  notFound: string[];
}

export interface StatusResult {
  updated: number;
  notFound: string[];
}

export interface MutationDeps {
  clearSchedule(entryId: string): void;
  clearCookies?(entryId: string): void;
  clearWarnings?(entryId: string): void;
}

export class AccountMutationService {
  constructor(
    private pool: AccountPool,
    private deps: MutationDeps,
  ) {}

  deleteBatch(ids: string[]): DeleteResult {
    let deleted = 0;
    const notFound: string[] = [];

    for (const id of ids) {
      this.deps.clearSchedule(id);
      const removed = this.pool.removeAccount(id);
      if (removed) {
        this.deps.clearCookies?.(id);
        this.deps.clearWarnings?.(id);
        deleted++;
      } else {
        notFound.push(id);
      }
    }

    return { deleted, notFound };
  }

  setStatusBatch(
    ids: string[],
    status: "active" | "disabled",
  ): StatusResult {
    let updated = 0;
    const notFound: string[] = [];

    for (const id of ids) {
      const entry = this.pool.getEntry(id);
      if (entry) {
        this.pool.markStatus(id, status);
        // Re-enabling clears any in-memory CF block streak so the account
        // gets a fresh allowance against the auto-disable threshold.
        if (status === "active") resetCfPathBlock(id);
        updated++;
      } else {
        notFound.push(id);
      }
    }

    return { updated, notFound };
  }
}
