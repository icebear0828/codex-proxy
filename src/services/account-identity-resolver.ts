import { getConfig } from "../config.js";
import { buildHeaders } from "../fingerprint/manager.js";
import type { CodexTokenMetadata } from "../auth/token-metadata.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";

type JsonRecord = Record<string, unknown>;

interface IdentityCandidate {
  accountId: string;
  organizationId: string | null;
  userId: string | null;
  planType: string | null;
  activeSubscription: boolean;
  isDefault: boolean;
}

export interface AccountIdentityDiscoveryOptions {
  proxyUrl?: string | null;
  baseUrl?: string;
  transport?: TlsTransport;
  /** Test-only escape hatch so unit tests do not need global fingerprint state. */
  headers?: Record<string, string>;
  accountIdHint?: string | null;
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeAccountId(value: unknown): string | null {
  const normalized = stringValue(value);
  if (!normalized) return null;
  // Account IDs are currently UUIDs, but keep this tolerant enough for future
  // opaque identifiers while rejecting header injection and oversized values.
  return /^[A-Za-z0-9_-]{8,128}$/.test(normalized) ? normalized : null;
}

function candidateFromAccountRecord(
  value: unknown,
  isDefault: boolean,
): IdentityCandidate | null {
  const wrapper = toRecord(value);
  const account = toRecord(wrapper?.account);
  if (!wrapper || !account) return null;
  const entitlement = toRecord(wrapper.entitlement);
  const accountId = safeAccountId(account.account_id);
  if (!accountId) return null;

  return {
    accountId,
    organizationId: stringValue(account.organization_id),
    userId: stringValue(account.account_owner_id) ?? stringValue(account.user_id),
    planType: stringValue(account.plan_type) ?? stringValue(entitlement?.subscription_plan),
    activeSubscription: entitlement?.has_active_subscription === true,
    isDefault,
  };
}

/** Pure parser kept separate from network I/O for deterministic regression tests. */
export function parseAccountIdentityResponse(
  payload: unknown,
  current: CodexTokenMetadata,
  accountIdHint?: string | null,
): CodexTokenMetadata | null {
  const root = toRecord(payload);
  const accounts = toRecord(root?.accounts);
  if (!root || !accounts) return null;

  const byId = new Map<string, IdentityCandidate>();
  for (const [key, value] of Object.entries(accounts)) {
    const candidate = candidateFromAccountRecord(value, key === "default");
    if (!candidate) continue;
    const existing = byId.get(candidate.accountId);
    if (!existing || candidate.isDefault) byId.set(candidate.accountId, candidate);
  }
  let candidates = [...byId.values()];
  if (candidates.length === 0) return null;

  if (current.userId) {
    const ownerMatches = candidates.filter((candidate) => candidate.userId === current.userId);
    if (ownerMatches.length > 0) candidates = ownerMatches;
  }
  if (current.organizationId) {
    const orgMatches = candidates.filter(
      (candidate) => candidate.organizationId === current.organizationId,
    );
    if (orgMatches.length > 0) candidates = orgMatches;
  }

  // File-level IDs are only tie-breaker hints after token-derived owner/org
  // filters. They are never promoted directly into ChatGPT-Account-Id.
  const normalizedHint = safeAccountId(accountIdHint);
  if (normalizedHint) {
    const hinted = candidates.find((candidate) => candidate.accountId === normalizedHint);
    if (hinted) candidates = [hinted];
  }

  candidates.sort((a, b) => {
    const aScore = (a.activeSubscription ? 2 : 0) + (a.isDefault ? 1 : 0);
    const bScore = (b.activeSubscription ? 2 : 0) + (b.isDefault ? 1 : 0);
    return bScore - aScore;
  });
  const selected = candidates[0];

  return {
    accountId: selected.accountId,
    organizationId: selected.organizationId ?? current.organizationId,
    userId: selected.userId ?? current.userId,
    email: current.email,
    planType: selected.planType ?? current.planType,
    accountIdSource: "upstream_discovery",
  };
}

function identityEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const timezoneOffset = new Date().getTimezoneOffset();
  return `${base}/accounts/check/v4-2023-04-27?timezone_offset_min=${timezoneOffset}`;
}

/**
 * Resolve the real ChatGPT workspace account ID without consuming a refresh
 * token. This follows the same account-check path used by Cockpit Tools.
 */
export async function discoverCodexAccountIdentity(
  token: string,
  current: CodexTokenMetadata,
  options: AccountIdentityDiscoveryOptions = {},
): Promise<CodexTokenMetadata> {
  const transport = options.transport ?? getTransport();
  const baseUrl = options.baseUrl ?? getConfig().api.base_url;
  const headers = options.headers
    ? { ...options.headers }
    : buildHeaders(token, null);
  headers.Accept = "application/json";
  if (!transport.isImpersonate()) headers["Accept-Encoding"] = "gzip, deflate";

  const result = await transport.get(
    identityEndpoint(baseUrl),
    headers,
    20,
    options.proxyUrl,
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Account identity endpoint returned HTTP ${result.status}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.body) as unknown;
  } catch {
    throw new Error("Account identity endpoint returned invalid JSON");
  }
  const resolved = parseAccountIdentityResponse(
    payload,
    current,
    options.accountIdHint,
  );
  if (!resolved?.accountId) {
    throw new Error("Account identity endpoint returned no matching workspace");
  }
  return resolved;
}
