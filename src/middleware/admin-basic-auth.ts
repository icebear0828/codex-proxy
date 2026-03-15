import { timingSafeEqual } from "crypto";
import type { Context, Next } from "hono";
import { getConfig } from "../config.js";

interface BasicAuthCredentials {
  username: string;
  password: string;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

export function isProtectedManagementPath(path: string): boolean {
  if (path === "/health") return false;
  if (path === "/v1" || path.startsWith("/v1/")) return false;
  if (path === "/v1beta" || path.startsWith("/v1beta/")) return false;
  return true;
}

export function parseBasicAuthHeader(
  authorization: string | undefined,
): BasicAuthCredentials | null {
  const raw = authorization?.trim();
  if (!raw) return null;

  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(raw);
  if (!match) return null;

  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export async function adminBasicAuth(c: Context, next: Next): Promise<void | Response> {
  if (!isProtectedManagementPath(c.req.path)) {
    await next();
    return;
  }

  const { admin_basic_auth_username, admin_basic_auth_password } = getConfig().server;
  if (admin_basic_auth_username === null || admin_basic_auth_password === null) {
    await next();
    return;
  }

  const credentials = parseBasicAuthHeader(c.req.header("Authorization"));
  const authenticated =
    credentials !== null &&
    secureEquals(credentials.username, admin_basic_auth_username) &&
    secureEquals(credentials.password, admin_basic_auth_password);

  if (authenticated) {
    await next();
    return;
  }

  c.header("WWW-Authenticate", 'Basic realm="Codex Proxy Admin", charset="UTF-8"');
  return c.text("Unauthorized", 401);
}
