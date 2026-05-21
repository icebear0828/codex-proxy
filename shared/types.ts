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
