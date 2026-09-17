/**
 * OpenCode / Console Go upstream compatibility.
 *
 * Console Go (https://opencode.ai/zen/go) rejects requests that omit the
 * `x-opencode-session` header, and routes a dialogue efficiently only when it
 * also receives the real client User-Agent. Direct clients (Codex, Kilo Code)
 * send both; through the proxy they are dropped or overwritten, so adapters
 * re-apply them here. When the client provides no session id, adapters
 * substitute a stable per-conversation id so each dialogue keeps routing.
 */

import type { CodexResponsesRequest } from "./codex-types.js";

export const X_OPENCODE_SESSION_HEADER = "x-opencode-session";

/** True when the baseUrl targets an OpenCode / Console Go upstream. */
export function isOpenCodeUpstream(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "opencode.ai"
      || host.endsWith(".opencode.ai")
      || /\/zen\/go(?:\/|$)/.test(url.pathname);
  } catch {
    return /opencode\.ai|\/zen\/go(?:\/|$)/.test(baseUrl);
  }
}

/**
 * Apply Console Go compatibility headers for the given request. No-op unless
 * the upstream is an OpenCode endpoint. The client-provided User-Agent is
 * forwarded verbatim (when present); the session header prefers the client's
 * own id and falls back to a stable per-conversation id for that dialogue.
 */
export function applyOpenCodeHeaders(
  headers: Record<string, string>,
  baseUrl: string,
  request: Pick<CodexResponsesRequest, "clientUserAgent" | "opencodeSessionId">,
  fallbackSessionId: string,
): void {
  if (!isOpenCodeUpstream(baseUrl)) return;
  if (request.clientUserAgent) headers["User-Agent"] = request.clientUserAgent;
  headers[X_OPENCODE_SESSION_HEADER] = request.opencodeSessionId ?? fallbackSessionId;
}
