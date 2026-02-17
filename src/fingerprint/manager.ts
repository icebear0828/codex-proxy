/**
 * Fingerprint manager — builds headers that mimic the Codex Desktop client.
 *
 * Based on Codex source: applyDesktopAuthHeaders / buildDesktopUserAgent
 */

import { getConfig, getFingerprint } from "../config.js";
import { extractChatGptAccountId } from "../auth/jwt-utils.js";

export function buildHeaders(
  token: string,
  accountId?: string | null,
): Record<string, string> {
  const config = getConfig();
  const fp = getFingerprint();
  const headers: Record<string, string> = {};

  headers["Authorization"] = `Bearer ${token}`;

  const acctId = accountId ?? extractChatGptAccountId(token);
  if (acctId) headers["ChatGPT-Account-Id"] = acctId;

  headers["originator"] = config.client.originator;

  const ua = fp.user_agent_template
    .replace("{version}", config.client.app_version)
    .replace("{platform}", config.client.platform)
    .replace("{arch}", config.client.arch);
  headers["User-Agent"] = ua;

  return headers;
}

export function buildHeadersWithContentType(
  token: string,
  accountId?: string | null,
): Record<string, string> {
  const headers = buildHeaders(token, accountId);
  headers["Content-Type"] = "application/json";
  return headers;
}
