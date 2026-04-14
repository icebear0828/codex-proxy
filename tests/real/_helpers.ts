/**
 * Shared helpers for real upstream integration tests.
 *
 * All tests require a running proxy at PROXY_URL (default: http://localhost:8080)
 * with at least one active account configured.
 */

export const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:8080";
export const API_KEY = process.env.PROXY_API_KEY ?? "pwd";
export const TIMEOUT = 30_000;

/**
 * Optional: set TEST_ACCOUNT to an email or account ID to isolate a single
 * account for the entire test run. All other accounts will be disabled on
 * setup and re-enabled on teardown.
 */
export const TEST_ACCOUNT = process.env.TEST_ACCOUNT ?? "";

let _proxyReachable: boolean | null = null;

/** Check proxy reachability (cached after first call). */
export async function checkProxy(): Promise<boolean> {
  if (_proxyReachable !== null) return _proxyReachable;
  try {
    const res = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(5000) });
    _proxyReachable = res.ok;
    if (!_proxyReachable) {
      console.warn(`[real] Proxy at ${PROXY_URL} returned ${res.status}, skipping`);
    }
  } catch {
    _proxyReachable = false;
    console.warn(`[real] Proxy at ${PROXY_URL} not reachable, skipping`);
  }
  return _proxyReachable;
}

/** Returns true when tests should be skipped (proxy not reachable). */
export function skip(): boolean {
  return !_proxyReachable;
}

/** Standard auth headers for proxy requests. */
export function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  };
}

/** Collect SSE `data:` lines from a response. */
export async function collectSSE(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

/** Collect SSE `event:` type lines from a response. */
export async function collectSSEEvents(res: Response): Promise<{ events: string[]; text: string }> {
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));
  return { events, text };
}

/** Extract JSON data lines from SSE text (already collected). */
export function parseDataLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

// ── Account management helpers ──────────────────────────────────────

export interface AccountInfo {
  id: string;
  email: string | null;
  status: string;
  planType: string | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  quota?: {
    plan_type: string;
    rate_limit: {
      allowed: boolean;
      limit_reached: boolean;
      used_percent: number | null;
      reset_at: number | null;
      limit_window_seconds: number | null;
    };
    secondary_rate_limit: {
      limit_reached: boolean;
      used_percent: number | null;
      reset_at: number | null;
      limit_window_seconds: number | null;
    } | null;
  };
  quotaFetchedAt?: string | null;
  usage: {
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    last_used: string | null;
    rate_limit_until: string | null;
    window_reset_at?: number | null;
    window_request_count?: number;
    window_input_tokens?: number;
    window_output_tokens?: number;
    limit_window_seconds?: number | null;
  };
}

interface ExportedAccount {
  id: string;
  email: string | null;
  status: string;
  refreshToken: string | null;
}

/** Full export with RT info (used internally to enrich AccountInfo). */
async function exportAccounts(): Promise<ExportedAccount[]> {
  const res = await fetch(`${PROXY_URL}/auth/accounts/export`, {
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
  const { accounts } = (await res.json()) as { accounts: ExportedAccount[] };
  return accounts;
}

/** List all accounts, enriched with hasRefreshToken. */
export async function listAccounts(): Promise<AccountInfo[]> {
  const [listRes, exported] = await Promise.all([
    fetch(`${PROXY_URL}/auth/accounts`, { headers: headers(), signal: AbortSignal.timeout(5000) }),
    exportAccounts(),
  ]);
  const { accounts } = (await listRes.json()) as { accounts: Omit<AccountInfo, "hasRefreshToken">[] };
  const rtSet = new Set(exported.filter((a) => a.refreshToken).map((a) => a.id));
  return accounts.map((a) => ({ ...a, hasRefreshToken: rtSet.has(a.id) }));
}

/** List only active accounts. */
export async function getActiveAccounts(): Promise<AccountInfo[]> {
  const all = await listAccounts();
  return all.filter((a) => a.status === "active");
}

/** Reset usage counters for an account. */
export async function resetUsage(id: string): Promise<void> {
  await fetch(`${PROXY_URL}/auth/accounts/${id}/reset-usage`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
}

/** Reset usage counters for all active accounts. */
export async function resetAllUsage(): Promise<void> {
  const accounts = await getActiveAccounts();
  await Promise.all(accounts.map((a) => resetUsage(a.id)));
}

/** Set status for multiple accounts. */
export async function setAccountStatus(ids: string[], status: "active" | "disabled"): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${PROXY_URL}/auth/accounts/batch-status`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ids, status }),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Isolate a single account: disable all other active accounts.
 * Returns a cleanup function that re-enables them.
 */
export async function isolateAccount(emailOrId: string): Promise<{ target: AccountInfo; restore: () => Promise<void> }> {
  const accounts = await listAccounts();
  const target = accounts.find((a) => a.email === emailOrId || a.id === emailOrId);
  if (!target) throw new Error(`Account "${emailOrId}" not found`);

  const toDisable = accounts.filter(
    (a) => a.id !== target.id && a.status === "active",
  );
  const disabledIds = toDisable.map((a) => a.id);

  if (disabledIds.length > 0) {
    await setAccountStatus(disabledIds, "disabled");
  }

  return {
    target,
    restore: async () => {
      if (disabledIds.length > 0) {
        await setAccountStatus(disabledIds, "active");
      }
    },
  };
}

/** Send a lightweight non-streaming chat completion request. */
export async function sendQuickRequest(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "codex",
      messages: [{ role: "user", content: "Reply with just the word 'ok'." }],
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

/** Parse SSE text into event types and data lines. */
export function parseSSE(text: string): { events: string[]; dataLines: string[] } {
  const lines = text.split("\n");
  const events = lines.filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
  const dataLines = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  return { events, dataLines };
}

/** Anthropic-style auth headers (x-api-key, no redundant Authorization). */
export function anthropicHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
  };
}
