/**
 * Data models for multi-account management.
 */

export type AccountStatus =
  | "active"
  | "expired"
  | "rate_limited"
  | "refreshing"
  | "disabled";

export interface AccountUsage {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  last_used: string | null;
  rate_limit_until: string | null;
}

export interface AccountEntry {
  id: string;
  token: string;
  refreshToken: string | null;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  proxyApiKey: string;
  status: AccountStatus;
  usage: AccountUsage;
  addedAt: string;
}

/** Public info (no token) */
export interface AccountInfo {
  id: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  status: AccountStatus;
  usage: AccountUsage;
  addedAt: string;
  expiresAt: string | null;
  quota?: CodexQuota;
}

/** Official Codex quota from /backend-api/codex/usage */
export interface CodexQuota {
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    used_percent: number | null;
    reset_at: number | null;
  };
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
