export interface AccountQuotaWindow {
  used_percent?: number | null;
  limit_reached?: boolean;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
}

export interface AccountQuota {
  rate_limit?: AccountQuotaWindow;
  secondary_rate_limit?: AccountQuotaWindow | null;
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
    window_request_count?: number;
    window_input_tokens?: number;
    window_output_tokens?: number;
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
