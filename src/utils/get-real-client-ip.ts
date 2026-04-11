import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AppConfig } from "../config-schema.js";

/**
 * Returns the effective client IP address.
 *
 * When `trust_proxy` is false (default), returns the raw socket address from
 * getConnInfo — safe for direct connections.
 *
 * When `trust_proxy` is true, prefers X-Forwarded-For / X-Real-IP headers set
 * by reverse proxies or tunnel software (frp, ngrok, etc.), falling back to the
 * socket address if no header is present.
 *
 * Only enable trust_proxy when codex-proxy sits behind a trusted reverse proxy.
 * Enabling it on a direct internet connection allows clients to spoof their IP.
 */
export function getRealClientIp(c: Context, config: AppConfig): string {
  const socketAddr = getConnInfo(c).remote.address ?? "";
  if (!config.server.trust_proxy) return socketAddr;

  // X-Forwarded-For: client, proxy1, proxy2 — take leftmost (original client)
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }

  const xri = c.req.header("x-real-ip");
  if (xri?.trim()) return xri.trim();

  return socketAddr;
}
