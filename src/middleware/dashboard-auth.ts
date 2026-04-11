/**
 * Dashboard Auth Middleware — cookie-based login gate for the web dashboard.
 *
 * When proxy_api_key is configured and the request originates from a non-localhost
 * address, require a valid _codex_session cookie. Protects dashboard data endpoints
 * while allowing: static assets, health, API routes, login endpoints, and HTML shell.
 */

import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import { isLocalhostRequest } from "../utils/is-localhost.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { validateSession } from "../auth/dashboard-session.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";

/** Detect HTTPS from X-Forwarded-Proto or protocol. */
function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

/** Paths that are always allowed through without dashboard session. */
const ALLOWED_PREFIXES = ["/assets/", "/v1/", "/v1beta/"];
const ALLOWED_EXACT = new Set([
  "/health",
  "/auth/dashboard-login",
  "/auth/dashboard-logout",
  "/auth/dashboard-status",
]);
/** GET-only paths allowed (HTML shell must load to render login form). */
const ALLOWED_GET_EXACT = new Set(["/"]);


export async function dashboardAuth(c: Context, next: Next): Promise<Response | void> {
  const config = getConfig();

  // No key configured → no gate
  if (!config.server.proxy_api_key) return next();

  // Localhost → bypass (Electron + local dev)
  const remoteAddr = getRealClientIp(c, config.server.trust_proxy);
  if (isLocalhostRequest(remoteAddr)) return next();

  // Always-allowed paths
  const path = c.req.path;
  if (ALLOWED_EXACT.has(path)) return next();
  if (ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return next();
  if (c.req.method === "GET" && ALLOWED_GET_EXACT.has(path)) return next();

  // Check session cookie
  const sessionId = parseSessionCookie(c.req.header("cookie"));
  if (sessionId && validateSession(sessionId)) {
    // Sliding window: refresh cookie Max-Age to stay in sync with server-side renewal
    const maxAge = config.session.ttl_minutes * 60;
    const secure = isHttps(c);
    let cookie = `_codex_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    if (secure) cookie += "; Secure";
    c.header("Set-Cookie", cookie);
    return next();
  }

  // Not authenticated — reject
  c.status(401);
  return c.json({ error: "Dashboard login required" });
}
