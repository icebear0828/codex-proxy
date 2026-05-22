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
  code_review?: {
    allowed?: boolean;
    limit_reached?: boolean;
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
  const codeReview =
    parseDetailsFromHeaders(get, "x-codex-code-review") ??
    parseDetailsFromHeaders(get, "x-codex-review") ??
    parseDetailsFromHeaders(get, "x-code-review");

  if (!primary && !secondary && !codeReview) return null;
  return { primary, secondary, code_review: codeReview };
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
  const remainingPercent = (used: number | null | undefined): number | null =>
    typeof used === "number" && Number.isFinite(used)
      ? Math.max(0, Math.min(100, Math.round(100 - Math.max(0, Math.min(100, used)))))
      : null;

  return {
    plan_type: planType ?? "unknown",
    rate_limit: {
      used_percent: primary?.used_percent ?? null,
      remaining_percent: remainingPercent(primary?.used_percent),
      reset_at: primary?.reset_at ?? null,
      limit_window_seconds: primary?.window_minutes != null ? primary.window_minutes * 60 : null,
      allowed: true,
      limit_reached: (primary?.used_percent ?? 0) >= 100,
    },
    secondary_rate_limit: secondary
      ? {
          used_percent: secondary.used_percent,
          remaining_percent: remainingPercent(secondary.used_percent),
          reset_at: secondary.reset_at,
          limit_window_seconds: secondary.window_minutes != null ? secondary.window_minutes * 60 : null,
          limit_reached: secondary.used_percent >= 100,
        }
      : null,
    code_review_rate_limit: rl.code_review
      ? {
          allowed: rl.code_review.allowed ?? true,
          limit_reached:
            rl.code_review.limit_reached ??
            (rl.code_review.primary?.used_percent ?? 0) >= 100,
          used_percent: rl.code_review.primary?.used_percent ?? null,
          remaining_percent: remainingPercent(rl.code_review.primary?.used_percent),
          reset_at: rl.code_review.primary?.reset_at ?? null,
          limit_window_seconds:
            rl.code_review.primary?.window_minutes != null
              ? rl.code_review.primary.window_minutes * 60
              : null,
        }
      : null,
  };
}

// ── Window shape (shared by header parsing and event parsing) ───

interface RateLimitWindowData {
  used_percent: number;
  window_minutes: number | null;
  reset_at: number | null;
}

/**
 * Parse rate-limit data from a `codex.rate_limits` WebSocket SSE event.
 * Returns null if the payload is not a valid rate_limits event.
 *
 * Expected shape (from codex-rs `codex.rate_limits` event):
 * ```json
 * {
 *   "rate_limits": {
 *     "primary": { "used_percent": 42.0, "window_minutes": 300, "reset_at": 1700000000 },
 *     "secondary": { "used_percent": 18.0, "window_minutes": 10080, "reset_at": 1700500000 }
 *   }
 * }
 * ```
 */
export function parseRateLimitsEvent(data: unknown): ParsedRateLimit | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const rl = parseDetailsFromObject(obj.rate_limits);
  const explicitCodeReview =
    parseDetailsFromObject(obj.code_review_rate_limits) ??
    parseDetailsFromObject(obj.code_review_rate_limit);

  let primary = rl?.primary ?? null;
  let secondary = rl?.secondary ?? null;
  let codeReview = explicitCodeReview;

  const limitName =
    typeof obj.metered_limit_name === "string"
      ? obj.metered_limit_name
      : typeof obj.limit_name === "string"
        ? obj.limit_name
        : null;
  if (rl && isReviewLimitName(limitName)) {
    codeReview = codeReview ?? rl;
    primary = null;
    secondary = null;
  }

  if (!primary && !secondary && !codeReview) return null;
  return { primary, secondary, code_review: codeReview };
}

function parseDetailsFromObject(value: unknown): ParsedRateLimit["code_review"] {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const primary = parseWindowFromObject(obj.primary);
  const secondary = parseWindowFromObject(obj.secondary);
  if (!primary && !secondary) return null;
  return {
    allowed: typeof obj.allowed === "boolean" ? obj.allowed : undefined,
    limit_reached: typeof obj.limit_reached === "boolean" ? obj.limit_reached : undefined,
    primary,
    secondary,
  };
}

function parseWindowFromObject(win: unknown): RateLimitWindowData | null {
  if (!win || typeof win !== "object") return null;
  const w = win as Record<string, unknown>;
  const pct = typeof w.used_percent === "number" ? w.used_percent : NaN;
  if (!isFinite(pct)) return null;

  return {
    used_percent: pct,
    window_minutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
    reset_at: typeof w.reset_at === "number" ? w.reset_at : null,
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

function parseDetailsFromHeaders(
  get: (name: string) => string | null,
  prefix: string,
): NonNullable<ParsedRateLimit["code_review"]> | null {
  const primary = parseWindow(get, `${prefix}-primary`);
  const secondary = parseWindow(get, `${prefix}-secondary`);
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

function isReviewLimitName(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return normalized === "review" ||
    normalized === "code_review" ||
    normalized === "codex_review" ||
    normalized === "codex_code_review";
}
