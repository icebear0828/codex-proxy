/**
 * Data models for multi-account management.
 */

export type AccountStatus =
  | "active"
  | "expired"
  | "rate_limited"
  | "refreshing"
  | "disabled"
  | "banned";

export interface AccountUsage {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  empty_response_count: number;
  last_used: string | null;
  rate_limit_until: string | null;
  /** Tracks the current rate limit window end (Unix seconds). When window rolls over, counters reset. */
  window_reset_at?: number | null;
  /** Per-window request count (resets when window expires). */
  window_request_count?: number;
  /** Per-window input tokens (resets when window expires). */
  window_input_tokens?: number;
  /** Per-window output tokens (resets when window expires). */
  window_output_tokens?: number;
  /** ISO timestamp of when window counters were last reset. */
  window_counters_reset_at?: string | null;
  /** Window duration in seconds, synced from backend, used for local window estimation. */
  limit_window_seconds?: number | null;
}

export interface AccountEntry {
  id: string;
  token: string;
  refreshToken: string | null;
  email: string | null;
  accountId: string | null;
  /** Per-user unique ID (chatgpt_user_id). Team members share accountId but have distinct userId. */
  userId: string | null;
  /** User-editable label for disambiguation (e.g. "Team Alpha", "Personal"). */
  label: string | null;
  planType: string | null;
  proxyApiKey: string;
  status: AccountStatus;
  usage: AccountUsage;
  addedAt: string;
  /** Cached official quota from background refresh. Null until first fetch. */
  cachedQuota: CodexQuota | null;
  /** ISO timestamp of when cachedQuota was last updated. */
  quotaFetchedAt: string | null;
}

/** Public info (no token) */
export interface AccountInfo {
  id: string;
  email: string | null;
  accountId: string | null;
  userId: string | null;
  label: string | null;
  planType: string | null;
  status: AccountStatus;
  usage: AccountUsage;
  addedAt: string;
  expiresAt: string | null;
  quota?: CodexQuota;
  quotaFetchedAt?: string | null;
}

/** A single rate limit window (primary or secondary). */
export interface CodexQuotaWindow {
  used_percent: number | null;
  reset_at: number | null;
  limit_window_seconds: number | null;
}

/** Official Codex quota from /backend-api/codex/usage */
export interface CodexQuota {
  plan_type: string;
  rate_limit: CodexQuotaWindow & {
    allowed: boolean;
    limit_reached: boolean;
  };
  /** Secondary rate limit window (e.g. weekly cap). Null when backend doesn't report one. */
  secondary_rate_limit: CodexQuotaWindow & {
    limit_reached: boolean;
  } | null;
  code_review_rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    used_percent: number | null;
    reset_at: number | null;
  } | null;
}

/** Returned by acquire() */
export interface AcquiredAccount {
  entryId: string;
  token: string;
  accountId: string | null;
}

/** Persistence format */
export interface AccountsFile {
  accounts: AccountEntry[];
}
