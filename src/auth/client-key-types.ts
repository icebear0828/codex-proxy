/**
 * Types and interfaces for distributed client access keys.
 */

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

