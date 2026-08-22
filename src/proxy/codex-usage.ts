/**
 * Codex usage/quota API query.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import {
  CodexApiError,
  type CodexResetCreditItem,
  type CodexResetCreditsResponse,
  type CodexUsageResponse,
} from "./codex-types.js";

function usageUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [`${trimmed}/wham/usage`, `${trimmed}/codex/usage`];
  }
  return [`${trimmed}/api/codex/usage`, `${trimmed}/codex/usage`];
}

function resetCreditsUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [
      `${trimmed}/wham/rate-limit-reset-credits`,
      `${trimmed}/codex/rate-limit-reset-credits`,
    ];
  }
  return [
    `${trimmed}/backend-api/wham/rate-limit-reset-credits`,
    `${trimmed}/api/codex/rate-limit-reset-credits`,
    `${trimmed}/codex/rate-limit-reset-credits`,
  ];
}

function resetCreditsConsumeUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [
      `${trimmed}/wham/rate-limit-reset-credits/consume`,
      `${trimmed}/codex/rate-limit-reset-credits/consume`,
    ];
  }
  return [
    `${trimmed}/backend-api/wham/rate-limit-reset-credits/consume`,
    `${trimmed}/api/codex/rate-limit-reset-credits/consume`,
    `${trimmed}/codex/rate-limit-reset-credits/consume`,
  ];
}

export function parseResetCreditsSnapshot(payload: unknown): CodexResetCreditsResponse {
  if (!payload || typeof payload !== "object") {
    return { credits: [], available_count: 0, next_expires_at: null };
  }
  const obj = payload as Record<string, unknown>;
  const data = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
  const rawCredits = Array.isArray(data.credits) ? data.credits : [];
  const credits: CodexResetCreditItem[] = rawCredits.map((item) => {
    if (!item || typeof item !== "object") return {};
    const c = item as Record<string, unknown>;
    return {
      id: typeof c.id === "string" ? c.id : undefined,
      status: typeof c.status === "string" ? c.status : typeof c.raw_status === "string" ? c.raw_status : undefined,
      reset_type: typeof c.reset_type === "string" ? c.reset_type : undefined,
      granted_at: typeof c.granted_at === "number" && Number.isFinite(c.granted_at) ? c.granted_at : null,
      expires_at: typeof c.expires_at === "number" && Number.isFinite(c.expires_at) ? c.expires_at : null,
      redeemed_at: typeof c.redeemed_at === "number" && Number.isFinite(c.redeemed_at) ? c.redeemed_at : null,
      raw_status: typeof c.raw_status === "string" ? c.raw_status : typeof c.status === "string" ? c.status : undefined,
    };
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const isAvailable = (credit: CodexResetCreditItem) => {
    const s = (credit.status || credit.raw_status || "available").trim().toLowerCase();
    if (s === "redeemed" || s === "used" || s === "consumed" || s === "expired") {
      return false;
    }
    if (typeof credit.expires_at === "number" && Number.isFinite(credit.expires_at) && credit.expires_at <= nowSec) {
      return false;
    }
    return true;
  };

  let availableCount: number | null = null;
  const rawCount = data.available_count ?? data.availableCount;
  if (typeof rawCount === "number" && Number.isFinite(rawCount)) {
    availableCount = rawCount;
  } else {
    availableCount = credits.filter(isAvailable).length;
  }

  const nextExpiresAt = credits
    .filter(isAvailable)
    .map((c) => c.expires_at)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b)[0] ?? null;

  return {
    available_count: availableCount,
    credits,
    next_expires_at: nextExpiresAt,
  };
}

export async function fetchUsage(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<CodexUsageResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  let lastBody = "";
  let lastError: string | null = null;
  for (const url of usageUrls(resolvedBaseUrl)) {
    let body: string;
    try {
      const result = await transport.get(url, headers, 15, proxyUrl);
      body = result.body;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastBody = body;

    try {
      const parsed = JSON.parse(body) as CodexUsageResponse;
      if (!parsed.rate_limit) {
        lastError = `Unexpected response from ${url}: ${body.slice(0, 200)}`;
        continue;
      }
      return parsed;
    } catch (e) {
      if (e instanceof CodexApiError) throw e;
      lastError = `Invalid JSON from ${url}: ${body.slice(0, 200)}`;
    }
  }

  if (lastBody) throw new CodexApiError(502, lastError ?? `Invalid usage response: ${lastBody.slice(0, 200)}`);
  throw new CodexApiError(0, `transport GET failed: ${lastError ?? "unknown error"}`);
}

export async function fetchResetCredits(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<CodexResetCreditsResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  let lastBody = "";
  let lastError: string | null = null;
  for (const url of resetCreditsUrls(resolvedBaseUrl)) {
    let body: string;
    let status = 200;
    try {
      const result = await transport.get(url, headers, 15, proxyUrl);
      status = result.status;
      body = result.body;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastBody = body;

    if (status < 200 || status >= 300) {
      lastError = `HTTP ${status}: ${body.slice(0, 200)}`;
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(body);
      return parseResetCreditsSnapshot(parsed);
    } catch (e) {
      if (e instanceof CodexApiError) throw e;
      lastError = `Invalid JSON from ${url}: ${body.slice(0, 200)}`;
    }
  }

  if (lastBody) throw new CodexApiError(502, lastError ?? `Invalid reset credits response: ${lastBody.slice(0, 200)}`);
  throw new CodexApiError(0, `transport GET failed: ${lastError ?? "unknown error"}`);
}

export async function consumeResetCredit(
  headers: Record<string, string>,
  redeemRequestId?: string,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<void> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();

  headers["Accept"] = "application/json";
  headers["Content-Type"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  const payload = JSON.stringify({
    redeem_request_id: redeemRequestId || crypto.randomUUID(),
  });

  let lastBody = "";
  let lastError: string | null = null;
  for (const url of resetCreditsConsumeUrls(resolvedBaseUrl)) {
    let body: string;
    let status = 200;
    try {
      const result = await transport.simplePost(url, headers, payload, 15, proxyUrl);
      status = result.status;
      body = result.body;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastBody = body;

    if (status >= 200 && status < 300) {
      return;
    }

    lastError = `HTTP ${status}: ${body.slice(0, 200)}`;
    throw new CodexApiError(status, body);
  }

  if (lastBody) throw new CodexApiError(502, lastError ?? `Invalid consume reset credit response: ${lastBody.slice(0, 200)}`);
  throw new CodexApiError(0, `transport POST failed: ${lastError ?? "unknown error"}`);
}
