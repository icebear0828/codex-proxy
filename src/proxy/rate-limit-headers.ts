/**
 * Parse Codex rate-limit info from upstream response headers.
 *
 * The Codex backend attaches quota data to every POST /codex/responses reply
 * via x-codex-* headers. This module extracts that data so we can cache it
 * on the account without making a separate GET /codex/usage call.
 *
 * Header families (prefix = "x-codex" by default):
 *   {prefix}-primary-used-percent
 *   {prefix}-primary-window-minutes
 *   {prefix}-primary-reset-at
 *   {prefix}-secondary-used-percent
 *   {prefix}-secondary-window-minutes
 *   {prefix}-secondary-reset-at
 *   {prefix}-credits-has-credits
 *   {prefix}-credits-unlimited
 *   {prefix}-credits-balance
 *   {prefix}-active-limit
 */

import type { CodexQuota, CodexQuotaWindow } from "../auth/types.js";

export interface ParsedRateLimit {
  primary: {
    used_percent: number;
    window_minutes: number | null;
    reset_at: number | null;
  } | null;
  secondary: {
    used_percent: number;
    window_minutes: number | null;
    reset_at: number | null;
  } | null;
}

/**
 * Extract rate-limit data from response headers.
 * Returns null if no rate-limit headers are present.
 */
export function parseRateLimitHeaders(headers: Headers | Record<string, string>): ParsedRateLimit | null {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    return headers[name] ?? null;
  };

  const primary = parseWindow(get, "x-codex-primary");
  const secondary = parseWindow(get, "x-codex-secondary");

  if (!primary && !secondary) return null;
  return { primary, secondary };
}

/**
 * Convert parsed rate-limit headers into a CodexQuota object
 * suitable for caching on AccountEntry.
 */
export function rateLimitToQuota(
  rl: ParsedRateLimit,
  planType: string | null,
): CodexQuota {
  const primary = rl.primary;
  const secondary = rl.secondary;

  return {
    plan_type: planType ?? "unknown",
    rate_limit: {
      used_percent: primary?.used_percent ?? null,
      reset_at: primary?.reset_at ?? null,
      limit_window_seconds: primary?.window_minutes != null ? primary.window_minutes * 60 : null,
      allowed: true,
      limit_reached: (primary?.used_percent ?? 0) >= 100,
    },
    secondary_rate_limit: secondary
      ? {
          used_percent: secondary.used_percent,
          reset_at: secondary.reset_at,
          limit_window_seconds: secondary.window_minutes != null ? secondary.window_minutes * 60 : null,
          limit_reached: secondary.used_percent >= 100,
        }
      : null,
    code_review_rate_limit: null,
  };
}

function parseWindow(
  get: (name: string) => string | null,
  prefix: string,
): { used_percent: number; window_minutes: number | null; reset_at: number | null } | null {
  const pctStr = get(`${prefix}-used-percent`);
  if (pctStr == null) return null;

  const pct = parseFloat(pctStr);
  if (!isFinite(pct)) return null;

  const winStr = get(`${prefix}-window-minutes`);
  const resetStr = get(`${prefix}-reset-at`);

  return {
    used_percent: pct,
    window_minutes: winStr ? parseInt(winStr, 10) || null : null,
    reset_at: resetStr ? parseInt(resetStr, 10) || null : null,
  };
}
