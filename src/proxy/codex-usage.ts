/**
 * Codex usage/quota API query.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import { CodexApiError, type CodexUsageResponse } from "./codex-types.js";

function usageUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.includes("/backend-api")) {
    return [`${trimmed}/wham/usage`, `${trimmed}/codex/usage`];
  }
  return [`${trimmed}/api/codex/usage`, `${trimmed}/codex/usage`];
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
