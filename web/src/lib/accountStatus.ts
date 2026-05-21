/**
 * Derived account status helpers.
 *
 * The backend now stores account.status as a pure rotation marker
 * (`active | expired | refreshing | disabled | banned | quota_exhausted`).
 * The "已限速 / rate_limited" state is no longer a backend-level enum value;
 * it lives in `account.quota.<bucket>.limit_reached` instead. The dashboard
 * derives the user-facing label from both signals via {@link derivedStatus}.
 *
 * Keep this helper as the single derivation point so all components agree.
 */

import type { Account, AccountQuota } from "../../../shared/types";

/** True when any of the 3 cachedQuota buckets reports limit_reached. */
export function isQuotaExhausted(quota: AccountQuota | undefined | null): boolean {
  if (!quota) return false;
  return quota.rate_limit?.limit_reached === true ||
    quota.secondary_rate_limit?.limit_reached === true ||
    quota.code_review_rate_limit?.limit_reached === true;
}

/**
 * Effective status: cachedQuota wins over backend status when any bucket
 * limit is reached. Returns the string the existing `statusStyles` map keys
 * on (active, expired, quota_exhausted, refreshing, disabled, banned,
 * rate_limited).
 */
export function derivedStatus(account: Account): string {
  if (account.status === "active" && isQuotaExhausted(account.quota)) {
    return "rate_limited";
  }
  return account.status;
}
