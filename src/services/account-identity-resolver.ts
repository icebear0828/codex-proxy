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

function usageEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/wham/usage`;
}

function headersForAccount(
  token: string,
  accountId: string | null,
  transport: TlsTransport,
  supplied?: Record<string, string>,
): Record<string, string> {
  const headers = supplied
    ? { ...supplied }
    : buildHeaders(token, accountId);

  // Test-supplied/base headers may contain a stale account header. Identity
  // discovery must start without one and add only an upstream-confirmed value.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "chatgpt-account-id") delete headers[key];
  }
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  headers.Accept = "application/json";
  if (!transport.isImpersonate()) headers["Accept-Encoding"] = "gzip, deflate";
  return headers;
}

async function getJson(
  transport: TlsTransport,
  url: string,
  headers: Record<string, string>,
  proxyUrl: string | null | undefined,
  label: string,
): Promise<unknown> {
  let result: Awaited<ReturnType<TlsTransport["get"]>> | null = null;
  let lastNetworkError: unknown;
  // These are read-only identity GETs. Retry one transport exception so a
  // transient TLS close/reset does not turn a valid import into a hard failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await transport.get(url, headers, 20, proxyUrl);
      break;
    } catch (err) {
      lastNetworkError = err;
    }
  }
  if (!result) {
    const detail = lastNetworkError instanceof Error
      ? lastNetworkError.message
      : String(lastNetworkError);
    throw new Error(`${label} request failed: ${detail}`);
  }
  if (result.status < 200 || result.status >= 300) {
    // Never include the upstream body: auth endpoints may echo sensitive data.
    throw new Error(`${label} returned HTTP ${result.status}`);
  }
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

/** Parse the account ID returned by the authenticated quota endpoint. */
export function parseUsageIdentityResponse(
  payload: unknown,
  current: CodexTokenMetadata,
  expectedAccountId?: string | null,
): CodexTokenMetadata | null {
  const root = toRecord(payload);
  if (!root) return null;
  const accountId = safeAccountId(
    root.account_id ?? root.accountId ?? root.chatgpt_account_id ?? root.workspace_id,
  );
  if (!accountId) return null;

  const expected = safeAccountId(expectedAccountId);
  if (expected && accountId !== expected) return null;

  return {
    accountId,
    organizationId: current.organizationId,
    userId: stringValue(root.user_id) ?? stringValue(root.chatgpt_user_id) ?? current.userId,
    email: stringValue(root.email) ?? current.email,
    planType: stringValue(root.plan_type) ?? current.planType,
    accountIdSource: "upstream_discovery",
  };
}

/**
 * Resolve a ChatGPT account ID without consuming a refresh token.
 *
 * Preferred path: /accounts/check returns the workspace list.
 * Safe fallback: some valid access-token-only accounts receive HTTP 403 from
 * /accounts/check but /wham/usage works without an account header. In that
 * case, accept only the account_id returned by upstream and verify it with a
 * second quota request carrying ChatGPT-Account-Id.
 */
export async function discoverCodexAccountIdentity(
  token: string,
  current: CodexTokenMetadata,
  options: AccountIdentityDiscoveryOptions = {},
): Promise<CodexTokenMetadata> {
  const transport = options.transport ?? getTransport();
  const baseUrl = options.baseUrl ?? getConfig().api.base_url;
  const anonymousHeaders = headersForAccount(
    token,
    null,
    transport,
    options.headers,
  );
  let accountCheckError: string;
  try {
    const payload = await getJson(
      transport,
      identityEndpoint(baseUrl),
      anonymousHeaders,
      options.proxyUrl,
      "Account identity endpoint",
    );
    const resolved = parseAccountIdentityResponse(
      payload,
      current,
      options.accountIdHint,
    );
    if (!resolved?.accountId) {
      throw new Error("Account identity endpoint returned no matching workspace");
    }
    return resolved;
  } catch (err) {
    accountCheckError = err instanceof Error ? err.message : String(err);
  }

  try {
    const initialUsage = await getJson(
      transport,
      usageEndpoint(baseUrl),
      anonymousHeaders,
      options.proxyUrl,
      "Account usage discovery endpoint",
    );
    const discovered = parseUsageIdentityResponse(initialUsage, current);
    if (!discovered?.accountId) {
      throw new Error("Account usage discovery endpoint returned no account ID");
    }

    const verifiedUsage = await getJson(
      transport,
      usageEndpoint(baseUrl),
      headersForAccount(token, discovered.accountId, transport, options.headers),
      options.proxyUrl,
      "Account usage verification endpoint",
    );
    const verified = parseUsageIdentityResponse(
      verifiedUsage,
      discovered,
      discovered.accountId,
    );
    if (!verified?.accountId) {
      throw new Error("Account usage verification returned a different account ID");
    }
    return verified;
  } catch (err) {
    const usageError = err instanceof Error ? err.message : String(err);
    throw new Error(`${accountCheckError}; usage fallback failed: ${usageError}`);
  }
}
