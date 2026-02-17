/**
 * Fingerprint manager — builds headers that mimic the Codex Desktop client.
 *
 * Based on Codex source: applyDesktopAuthHeaders / buildDesktopUserAgent
 */

import { getConfig, getFingerprint } from "../config.js";
import { extractChatGptAccountId } from "../auth/jwt-utils.js";

/**
 * Reorder headers according to the fingerprint header_order config.
 * Keys not in the order list are appended at the end.
 */
function orderHeaders(
  headers: Record<string, string>,
  order: string[],
): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of order) {
    if (key in headers) {
      ordered[key] = headers[key];
    }
  }
  for (const key of Object.keys(headers)) {
    if (!(key in ordered)) {
      ordered[key] = headers[key];
    }
  }
  return ordered;
}

export function buildHeaders(
  token: string,
  accountId?: string | null,
): Record<string, string> {
  const config = getConfig();
  const fp = getFingerprint();
  const raw: Record<string, string> = {};

  raw["Authorization"] = `Bearer ${token}`;

  const acctId = accountId ?? extractChatGptAccountId(token);
  if (acctId) raw["ChatGPT-Account-Id"] = acctId;

  raw["originator"] = config.client.originator;

  const ua = fp.user_agent_template
    .replace("{version}", config.client.app_version)
    .replace("{platform}", config.client.platform)
    .replace("{arch}", config.client.arch);
  raw["User-Agent"] = ua;

  // Add browser-level default headers (Accept-Encoding, Accept-Language, etc.)
  if (fp.default_headers) {
    for (const [key, value] of Object.entries(fp.default_headers)) {
      raw[key] = value;
    }
  }

  return orderHeaders(raw, fp.header_order);
}

export function buildHeadersWithContentType(
  token: string,
  accountId?: string | null,
): Record<string, string> {
  const config = getConfig();
  const fp = getFingerprint();
  const raw = buildHeaders(token, accountId);
  raw["Content-Type"] = "application/json";
  return orderHeaders(raw, fp.header_order);
}
