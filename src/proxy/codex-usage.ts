/**
 * Codex usage/quota API query.
 */

import { getConfig } from "../config.js";
import { getTransport } from "../tls/transport.js";
import { CodexApiError, type CodexUsageResponse } from "./codex-types.js";

export async function fetchUsage(
  headers: Record<string, string>,
  proxyUrl?: string | null,
): Promise<CodexUsageResponse> {
  const config = getConfig();
  const transport = getTransport();
  const url = `${config.api.base_url}/codex/usage`;

  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }

  let body: string;
  try {
    const result = await transport.get(url, headers, 15, proxyUrl);
    body = result.body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CodexApiError(0, `transport GET failed: ${msg}`);
  }

  try {
    const parsed = JSON.parse(body) as CodexUsageResponse;
    if (!parsed.rate_limit) {
      throw new CodexApiError(502, `Unexpected response: ${body.slice(0, 200)}`);
    }
    return parsed;
  } catch (e) {
    if (e instanceof CodexApiError) throw e;
    throw new CodexApiError(502, `Invalid JSON from /codex/usage: ${body.slice(0, 200)}`);
  }
}
