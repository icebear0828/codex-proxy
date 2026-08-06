import type { Context } from "hono";
import type { CodexQuota } from "../../auth/types.js";

const CODEX_RATE_LIMIT_RESPONSE_HEADERS = [
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-at",
  "x-codex-primary-over-secondary-limit-percent",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-at",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited",
  "x-codex-credits-balance",
  "x-codex-active-limit",
  "x-codex-rate-limit-reached-type",
] as const;

/**
 * Preserve Codex quota metadata so clients such as Codex CLI can render
 * the primary and weekly (secondary) account limits in /status.
 *
 * WebSocket upstreams send rate limits as events rather than HTTP headers.
 * Those events are cached on the account pool, which provides a fallback for
 * the next response when the upstream response itself has no quota headers.
 */
export function forwardCodexRateLimitHeaders(
  c: Context,
  upstreamHeaders: Headers,
  cachedQuota?: CodexQuota | null,
): void {
  const forwarded = new Set<string>();
  for (const name of CODEX_RATE_LIMIT_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value !== null) {
      c.header(name, value);
      forwarded.add(name);
    }
  }

  if (!cachedQuota) return;

  const quotaHeaders: Array<[string, string | number | boolean | null | undefined]> = [
    ["x-codex-primary-used-percent", cachedQuota.rate_limit.used_percent],
    ["x-codex-primary-window-minutes", secondsToMinutes(cachedQuota.rate_limit.limit_window_seconds)],
    ["x-codex-primary-reset-at", cachedQuota.rate_limit.reset_at],
    ["x-codex-secondary-used-percent", cachedQuota.secondary_rate_limit?.used_percent],
    ["x-codex-secondary-window-minutes", secondsToMinutes(cachedQuota.secondary_rate_limit?.limit_window_seconds)],
    ["x-codex-secondary-reset-at", cachedQuota.secondary_rate_limit?.reset_at],
    ["x-codex-credits-has-credits", cachedQuota.credits?.has_credits],
    ["x-codex-credits-unlimited", cachedQuota.credits?.unlimited],
    ["x-codex-credits-balance", cachedQuota.credits?.balance],
    ["x-codex-rate-limit-reached-type", reachedType(cachedQuota)],
  ];

  for (const [name, value] of quotaHeaders) {
    if (forwarded.has(name)) continue;
    const headerValue = formatHeaderValue(value);
    if (headerValue !== undefined) {
      c.header(name, headerValue);
    }
  }
}

function secondsToMinutes(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return seconds / 60;
}

function reachedType(quota: CodexQuota): string | undefined {
  if (quota.rate_limit.limit_reached) return "primary";
  if (quota.secondary_rate_limit?.limit_reached) return "secondary";
  return undefined;
}

function formatHeaderValue(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
