/**
 * Direct-connection fallback for proxied requests.
 *
 * When a global proxy is configured, some endpoints (e.g. auth.openai.com)
 * may reject the proxy IP via Cloudflare challenge or cause TLS errors.
 * This module provides a generic wrapper that retries with a direct connection.
 */

import { getProxyUrl } from "./proxy.js";

/** Detect if an HTTP response is a Cloudflare challenge page. */
export function isCloudflareChallengeResponse(status: number, body: string): boolean {
  if (status !== 403) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("cf-mitigated") ||
    lower.includes("cf-chl-bypass") ||
    lower.includes("_cf_chl") ||
    lower.includes("attention required") ||
    lower.includes("just a moment")
  );
}

/** Detect if an error is a proxy/TLS network failure worth retrying direct. */
export function isProxyNetworkError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("ssl_error_syscall") ||
    msg.includes("schannel") ||
    msg.includes("connection reset by peer") ||
    msg.includes("socket hang up") ||
    msg.includes("could not resolve proxy") ||   // proxy hostname resolution failure
    msg.includes("curl exited with code 5") ||   // proxy resolution failure
    msg.includes("curl exited with code 35") ||  // TLS handshake failure
    msg.includes("curl exited with code 56")     // network receive error
  );
}

/**
 * Detect if a network error occurred BEFORE the request could have been
 * processed by the server. Only these errors are safe to retry with the
 * same one-time refresh token — retrying after a mid-connection failure
 * risks permanent RT loss (refresh_token_reused).
 */
export function isSafeToRetryRefresh(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("econnrefused") ||              // server not reachable
    msg.includes("could not resolve proxy") ||   // DNS failure
    msg.includes("could not resolve host") ||    // DNS failure
    msg.includes("curl exited with code 5") ||   // proxy resolution failure
    msg.includes("curl exited with code 6") ||   // DNS failure
    msg.includes("curl exited with code 7") ||   // connection refused
    msg.includes("curl exited with code 35")     // TLS handshake (before HTTP)
  );
}

export interface DirectFallbackOptions<T> {
  /** Label for log messages. */
  tag?: string;
  /** Check if a successful (non-thrown) result should trigger fallback (e.g. CF 403). */
  shouldFallback?: (result: T) => boolean;
}

/**
 * Execute an async operation with automatic direct-connection fallback.
 *
 * The callback receives `proxyUrl`:
 * - First call: `undefined` (use global proxy default)
 * - Fallback call: `null` (force direct, bypass proxy)
 *
 * If no global proxy is configured, runs once with no fallback.
 */
export async function withDirectFallback<T>(
  fn: (proxyUrl: string | null | undefined) => Promise<T>,
  options?: DirectFallbackOptions<T>,
): Promise<T> {
  const label = options?.tag ?? "DirectFallback";
  const hasProxy = getProxyUrl() !== null;

  try {
    const result = await fn(undefined);

    if (hasProxy && options?.shouldFallback?.(result)) {
      console.warn(`[${label}] Cloudflare challenge via proxy, retrying direct`);
      return await fn(null);
    }

    return result;
  } catch (err) {
    if (hasProxy && isProxyNetworkError(err)) {
      console.warn(`[${label}] Network/TLS error via proxy, retrying direct`);
      return await fn(null);
    }
    throw err;
  }
}
