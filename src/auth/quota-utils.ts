/**
 * Shared quota conversion utility.
 * Converts CodexUsageResponse (raw backend) → CodexQuota (normalized).
 */

import type { CodexQuota, CodexQuotaCredits } from "./types.js";
import type { CodexUsageCredits, CodexUsageRateLimit, CodexUsageResponse } from "../proxy/codex-api.js";

function normalizeCredits(raw: CodexUsageCredits | null | undefined): CodexQuotaCredits | null {
  if (!raw) return null;
  // balance must be parseable — upstream always sends a decimal string,
  // but defensively reject malformed payloads so the dashboard never
  // shows NaN credits.
  if (typeof raw.balance !== "string") return null;
  const balance = Number(raw.balance);
  if (!Number.isFinite(balance)) return null;
  return {
    has_credits: Boolean(raw.has_credits),
    unlimited: Boolean(raw.unlimited),
    overage_limit_reached: Boolean(raw.overage_limit_reached),
    balance,
  };
}

function remainingPercent(used: number | null | undefined): number | null {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - Math.max(0, Math.min(100, used)))));
}

function isReviewLimitId(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return normalized === "review" ||
    normalized === "code_review" ||
    normalized === "codex_review" ||
    normalized === "codex_code_review" ||
    normalized.includes("code_review") ||
    normalized.includes("codex_review");
}

function quotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  if (!rateLimit) return null;
  const usedPercent = rateLimit.primary_window?.used_percent ?? null;
  return {
    allowed: rateLimit.allowed,
    limit_reached: rateLimit.limit_reached,
    used_percent: usedPercent,
    remaining_percent: remainingPercent(usedPercent),
    reset_at: rateLimit.primary_window?.reset_at ?? null,
    limit_window_seconds: rateLimit.primary_window?.limit_window_seconds ?? null,
  };
}

function secondaryQuotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  const secondary = rateLimit?.secondary_window;
  if (!secondary) return null;
  const usedPercent = secondary.used_percent ?? null;
  return {
    limit_reached: secondary.used_percent != null ? secondary.used_percent >= 100 : Boolean(rateLimit?.limit_reached),
    used_percent: usedPercent,
    remaining_percent: remainingPercent(usedPercent),
    reset_at: secondary.reset_at ?? null,
    limit_window_seconds: secondary.limit_window_seconds ?? null,
  };
}

export function toQuota(usage: CodexUsageResponse): CodexQuota {
  const sw = usage.rate_limit.secondary_window;
  const primaryUsedPercent = usage.rate_limit.primary_window?.used_percent ?? null;
  const additional = usage.additional_rate_limits ?? [];
  const rateLimitsByLimitId: NonNullable<CodexQuota["rate_limits_by_limit_id"]> = {};
  for (const item of additional) {
    const limitId = item.metered_feature?.trim();
    if (!limitId) continue;
    const q = quotaFromRateLimit(item.rate_limit);
    if (!q) continue;
    rateLimitsByLimitId[limitId] = {
      limit_id: limitId,
      limit_name: item.limit_name || null,
      ...q,
      secondary_rate_limit: secondaryQuotaFromRateLimit(item.rate_limit),
    };
  }
  const additionalReview = additional.find((item) =>
    isReviewLimitId(item.metered_feature) || isReviewLimitId(item.limit_name)
  );
  const codeReviewRateLimit =
    quotaFromRateLimit(usage.code_review_rate_limit) ??
    quotaFromRateLimit(additionalReview?.rate_limit);

  return {
    plan_type: usage.plan_type,
    rate_limit: {
      allowed: usage.rate_limit.allowed,
      limit_reached: usage.rate_limit.limit_reached,
      used_percent: primaryUsedPercent,
      remaining_percent: remainingPercent(primaryUsedPercent),
      reset_at: usage.rate_limit.primary_window?.reset_at ?? null,
      limit_window_seconds: usage.rate_limit.primary_window?.limit_window_seconds ?? null,
    },
    secondary_rate_limit: secondaryQuotaFromRateLimit(usage.rate_limit),
    code_review_rate_limit: codeReviewRateLimit,
    rate_limits_by_limit_id: Object.keys(rateLimitsByLimitId).length > 0
      ? rateLimitsByLimitId
      : null,
    credits: normalizeCredits(usage.credits),
  };
}
