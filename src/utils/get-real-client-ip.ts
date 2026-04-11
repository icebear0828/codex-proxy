import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * Returns the effective client IP address.
 *
 * When `trustProxy` is false (default), returns the raw socket address.
 * When `trustProxy` is true, prefers X-Forwarded-For / X-Real-IP headers
 * set by reverse proxies or tunnel software, falling back to the socket
 * address if no header is present.
 */
export function getRealClientIp(c: Context, trustProxy: boolean): string {
  if (!trustProxy) {
    return getConnInfo(c).remote.address ?? "";
  }

  // X-Forwarded-For: client, proxy1, proxy2 — take leftmost (original client)
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }

  const xri = c.req.header("x-real-ip");
  if (xri) {
    const trimmed = xri.trim();
    if (trimmed) return trimmed;
  }

  return getConnInfo(c).remote.address ?? "";
}
