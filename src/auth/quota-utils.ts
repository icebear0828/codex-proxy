/**
 * Shared quota conversion utility.
 * Converts CodexUsageResponse (raw backend) → CodexQuota (normalized).
 */

import type { CodexQuota } from "./types.js";
import type { CodexUsageResponse } from "../proxy/codex-api.js";

/** True if either primary or secondary rate limit has been reached. */
export function isAnyLimitReached(quota: CodexQuota | null | undefined): boolean {
  if (!quota) return false;
  return quota.rate_limit.limit_reached
    || (quota.secondary_rate_limit?.limit_reached ?? false);
}

/** Latest reset_at (Unix seconds) across primary and secondary windows. Returns null if neither has one. */
export function maxResetAt(quota: CodexQuota | null | undefined): number | null {
  if (!quota) return null;
  const primary = quota.rate_limit.reset_at;
  const secondary = quota.secondary_rate_limit?.reset_at ?? null;
  if (primary == null && secondary == null) return null;
  return Math.max(primary ?? 0, secondary ?? 0);
}

export function toQuota(usage: CodexUsageResponse): CodexQuota {
  const sw = usage.rate_limit.secondary_window;
  return {
    plan_type: usage.plan_type,
    rate_limit: {
      allowed: usage.rate_limit.allowed,
      limit_reached: usage.rate_limit.limit_reached,
      used_percent: usage.rate_limit.primary_window?.used_percent ?? null,
      reset_at: usage.rate_limit.primary_window?.reset_at ?? null,
      limit_window_seconds: usage.rate_limit.primary_window?.limit_window_seconds ?? null,
    },
    secondary_rate_limit: sw
      ? {
          limit_reached: sw.used_percent != null ? sw.used_percent >= 100 : usage.rate_limit.limit_reached,
          used_percent: sw.used_percent ?? null,
          reset_at: sw.reset_at ?? null,
          limit_window_seconds: sw.limit_window_seconds ?? null,
        }
      : null,
    code_review_rate_limit: usage.code_review_rate_limit
      ? {
          allowed: usage.code_review_rate_limit.allowed,
          limit_reached: usage.code_review_rate_limit.limit_reached,
          used_percent:
            usage.code_review_rate_limit.primary_window?.used_percent ?? null,
          reset_at:
            usage.code_review_rate_limit.primary_window?.reset_at ?? null,
        }
      : null,
  };
}
