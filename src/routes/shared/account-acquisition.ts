/**
 * Account acquisition / release helpers for the proxy handler.
 *
 * Wraps AccountPool.acquire/release with logging and idempotent-release guard.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import type { AcquiredAccount } from "../../auth/types.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

/**
 * Acquire an account from the pool for the given model.
 * Returns null when no account is available.
 */
export function acquireAccount(
  pool: AccountPool,
  model: string,
  excludeIds?: string[],
  tag?: string,
  preferredEntryId?: string,
): AcquiredAccount | null {
  const acquired = pool.acquire({ model, excludeIds, preferredEntryId });
  if (!acquired && tag) {
    console.warn(`[${tag}] No available account for model "${model}"`);
  }
  return acquired;
}

/**
 * Release an account back to the pool.
 *
 * When a `guard` Set is provided, the release is idempotent:
 * if the entryId has already been released (tracked in the set),
 * the call is silently skipped. This prevents the 7-release-point
 * problem in the old proxy handler.
 */
export function releaseAccount(
  pool: AccountPool,
  entryId: string,
  usage?: UsageInfo,
  guard?: Set<string>,
): void {
  if (guard) {
    if (guard.has(entryId)) return;
    guard.add(entryId);
  }
  pool.release(entryId, usage);
}
