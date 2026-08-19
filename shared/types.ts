export interface AccountQuotaWindow {
  used_percent?: number | null;
  remaining_percent?: number | null;
  limit_reached?: boolean;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
}

export interface AccountQuotaCredits {
  has_credits: boolean;
  unlimited: boolean;
  overage_limit_reached: boolean;
  /** Numeric balance parsed from upstream's decimal-string field. */
  balance: number;
}

export interface AccountQuota {
  plan_type?: string;
  rate_limit?: AccountQuotaWindow;
  secondary_rate_limit?: AccountQuotaWindow | null;
  code_review_rate_limit?: (AccountQuotaWindow & { allowed?: boolean }) | null;
  rate_limits_by_limit_id?: Record<string, AccountQuotaWindow & {
    limit_id?: string;
    limit_name?: string | null;
    allowed?: boolean;
    secondary_rate_limit?: AccountQuotaWindow | null;
  }> | null;
  /** Credit accounting from /codex/usage. Null for Plus, present for Pro / PAYG. */
  credits?: AccountQuotaCredits | null;
}

export interface QuotaWarning {
  accountId: string;
  email: string | null;
  window: "primary" | "secondary";
  level: "warning" | "critical";
  usedPercent: number;
  resetAt: number | null;
}

export interface Account {
  id: string;
  email: string;
  label?: string;
  status: string;
  planType?: string;
  usage?: {
    request_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    /** image_generation tool tokens (gpt-image-2). */
    image_input_tokens?: number;
    image_output_tokens?: number;
    /** image_generation request counters (success vs failed). */
    image_request_count?: number;
    image_request_failed_count?: number;
    window_request_count?: number;
    window_input_tokens?: number;
    window_output_tokens?: number;
    window_image_input_tokens?: number;
    window_image_output_tokens?: number;
    window_image_request_count?: number;
    window_image_request_failed_count?: number;
  };
  quota?: AccountQuota;
  quotaFetchedAt?: string | null;
  proxyId?: string;
  proxyName?: string;
}

export interface ProxyHealthInfo {
  exitIp: string | null;
  latencyMs: number;
  lastChecked: string;
  error: string | null;
}

export interface ProxyEntry {
  id: string;
  name: string;
  url: string;
  status: "active" | "unreachable" | "disabled";
  health: ProxyHealthInfo | null;
  addedAt: string;
}

export interface ProxyAssignment {
  accountId: string;
  proxyId: string;
}

export type DiagnosticStatus = "pass" | "fail" | "skip";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  latencyMs: number;
  detail: string | null;
  error: string | null;
}

export interface TestConnectionResult {
  checks: DiagnosticCheck[];
  overall: DiagnosticStatus;
  timestamp: string;
}

export type ClientKeyStatus = "active" | "disabled";

export interface ClientKeyEntry {
  /** Unique ID, e.g. "ck_xxxxxxxx" */
  id: string;
  /** Human-readable key name/label */
  name: string;
  /** Full secret key string, e.g. "sk-proxy-..." */
  key: string;
  /** Current status */
  status: ClientKeyStatus;
  /** ISO 8601 expiry timestamp, or null for never expires */
  expires_at: string | null;
  /** Maximum spending limit in USD, or null for unlimited */
  max_budget_usd: number | null;
  /** Total USD cost consumed so far */
  used_cost_usd: number;
  /** Maximum token limit, or null for unlimited */
  max_tokens: number | null;
  /** Total tokens consumed so far */
  used_tokens: number;
  /** Max concurrent in-flight requests, or null for unlimited */
  max_concurrency: number | null;
  /** Whitelist of model IDs, or null/empty for all models allowed */
  allowed_models: string[] | null;
  /** Total requests served */
  request_count: number;
  /** ISO timestamp of last usage */
  last_used_at: string | null;
  /** ISO timestamp of creation */
  created_at: string;
  /** ISO timestamp of last update */
  updated_at: string;
}

export interface ClientKeyPublicSummary {
  id: string;
  name: string;
  key_masked: string;
  status: ClientKeyStatus;
  expires_at: string | null;
  max_budget_usd: number | null;
  used_cost_usd: number;
  max_tokens: number | null;
  used_tokens: number;
  max_concurrency: number | null;
  allowed_models: string[] | null;
  request_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateClientKeyInput {
  name: string;
  key?: string | null;
  expires_at?: string | null;
  max_budget_usd?: number | null;
  max_tokens?: number | null;
  max_concurrency?: number | null;
  allowed_models?: string[] | null;
}

export interface UpdateClientKeyInput {
  name?: string;
  expires_at?: string | null;
  max_budget_usd?: number | null;
  max_tokens?: number | null;
  max_concurrency?: number | null;
  allowed_models?: string[] | null;
  status?: ClientKeyStatus;
}

export interface ClientKeyAccessValidation {
  allowed: boolean;
  reason?: "key_not_found" | "key_disabled" | "key_expired" | "invalid_key_expiration" | "insufficient_quota" | "concurrency_limit_exceeded" | "model_not_allowed" | "master_key_conflict";
  message?: string;
  statusCode?: 401 | 403 | 429;
}

