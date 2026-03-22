/**
 * Dashboard Login Routes — cookie-based authentication for the web dashboard.
 *
 * Provides login/logout/status endpoints that work with the dashboard-auth middleware.
 * Uses the existing proxy_api_key as the dashboard password.
 */

import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getConfig } from "../config.js";
import { isLocalhostRequest } from "../utils/is-localhost.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";
import {
  createSession,
  validateSession,
  deleteSession,
} from "../auth/dashboard-session.js";

/** Per-IP brute-force tracking: IP → { count, resetAt } */
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (entry) failedAttempts.delete(ip); // cleanup expired
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

/** Detect HTTPS from X-Forwarded-Proto (reverse proxy) or protocol. */
function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

function buildCookieString(name: string, value: string, maxAge: number, secure: boolean): string {
  let cookie = `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  return cookie;
}

/** Reset rate-limit state — for tests only. */
export function _resetRateLimitForTest(): void {
  failedAttempts.clear();
}

export function createDashboardAuthRoutes(): Hono {
  const app = new Hono();

  // POST /auth/dashboard-login — validate proxy_api_key and set session cookie
  app.post("/auth/dashboard-login", async (c) => {
    const config = getConfig();
    const remoteAddr = getConnInfo(c).remote.address ?? "unknown";

    // Rate limit check
    if (!checkRateLimit(remoteAddr)) {
      c.status(429);
      return c.json({ error: "Too many login attempts. Try again later." });
    }

    let body: { password?: string };
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }

    const password = body.password;
    if (!password || typeof password !== "string") {
      c.status(400);
      return c.json({ error: "Password is required" });
    }

    const key = config.server.proxy_api_key ?? "";
    const a = Buffer.from(password);
    const b = Buffer.from(key);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      recordFailure(remoteAddr);
      c.status(401);
      return c.json({ error: "Invalid password" });
    }

    const session = createSession();
    const maxAge = config.session.ttl_minutes * 60;
    const secure = isHttps(c);
    c.header("Set-Cookie", buildCookieString("_codex_session", session.id, maxAge, secure));
    return c.json({ success: true });
  });

  // POST /auth/dashboard-logout — clear session and cookie
  app.post("/auth/dashboard-logout", (c) => {
    const sessionId = parseSessionCookie(c.req.header("cookie"));
    if (sessionId) {
      deleteSession(sessionId);
    }
    const secure = isHttps(c);
    c.header("Set-Cookie", buildCookieString("_codex_session", "", 0, secure));
    return c.json({ success: true });
  });

  // GET /auth/dashboard-status — check if login is required and current auth state
  app.get("/auth/dashboard-status", (c) => {
    const config = getConfig();

    // No key → no gate required
    if (!config.server.proxy_api_key) {
      return c.json({ required: false, authenticated: true });
    }

    // Localhost → no gate required
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    if (isLocalhostRequest(remoteAddr)) {
      return c.json({ required: false, authenticated: true });
    }

    // Check session
    const sessionId = parseSessionCookie(c.req.header("cookie"));
    const authenticated = !!sessionId && validateSession(sessionId);

    return c.json({ required: true, authenticated });
  });

  return app;
}
