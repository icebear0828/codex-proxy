/**
 * CookieJar — per-account cookie storage.
 *
 * Stores cookies (especially cf_clearance from Cloudflare) so that
 * GET endpoints like /codex/usage don't get blocked by JS challenges.
 *
 * Cookies are auto-captured from every ChatGPT API response's Set-Cookie
 * headers, and can also be set manually via the management API.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";

const COOKIE_FILE = resolve(process.cwd(), "data", "cookies.json");

export class CookieJar {
  private cookies: Map<string, Record<string, string>> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  /**
   * Set cookies for an account.
   * Accepts "name1=val1; name2=val2" string or a Record.
   * Merges with existing cookies.
   */
  set(accountId: string, cookies: string | Record<string, string>): void {
    const existing = this.cookies.get(accountId) ?? {};

    if (typeof cookies === "string") {
      for (const part of cookies.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name) existing[name] = value;
      }
    } else {
      Object.assign(existing, cookies);
    }

    this.cookies.set(accountId, existing);
    this.schedulePersist();
  }

  /**
   * Build the Cookie header value for a request.
   * Returns null if no cookies are stored.
   */
  getCookieHeader(accountId: string): string | null {
    const cookies = this.cookies.get(accountId);
    if (!cookies || Object.keys(cookies).length === 0) return null;
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  /**
   * Auto-capture Set-Cookie headers from an API response.
   * Call this after every successful fetch to chatgpt.com.
   */
  capture(accountId: string, response: Response): void {
    // getSetCookie() returns individual Set-Cookie header values
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    if (setCookies.length === 0) return;

    const existing = this.cookies.get(accountId) ?? {};
    let changed = false;

    for (const raw of setCookies) {
      // Format: "name=value; Path=/; Domain=...; ..."
      const semi = raw.indexOf(";");
      const pair = semi === -1 ? raw : raw.slice(0, semi);
      const eq = pair.indexOf("=");
      if (eq === -1) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && existing[name] !== value) {
        existing[name] = value;
        changed = true;
      }
    }

    if (changed) {
      this.cookies.set(accountId, existing);
      this.schedulePersist();
    }
  }

  /**
   * Capture cookies from raw Set-Cookie header strings (e.g. from curl).
   */
  captureRaw(accountId: string, setCookies: string[]): void {
    if (setCookies.length === 0) return;

    const existing = this.cookies.get(accountId) ?? {};
    let changed = false;

    for (const raw of setCookies) {
      const semi = raw.indexOf(";");
      const pair = semi === -1 ? raw : raw.slice(0, semi);
      const eq = pair.indexOf("=");
      if (eq === -1) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && existing[name] !== value) {
        existing[name] = value;
        changed = true;
      }
    }

    if (changed) {
      this.cookies.set(accountId, existing);
      this.schedulePersist();
    }
  }

  /** Get raw cookie record for an account. */
  get(accountId: string): Record<string, string> | null {
    return this.cookies.get(accountId) ?? null;
  }

  /** Clear all cookies for an account. */
  clear(accountId: string): void {
    if (this.cookies.delete(accountId)) {
      this.schedulePersist();
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 1000);
  }

  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const dir = dirname(COOKIE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this.cookies);
      const tmpFile = COOKIE_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpFile, COOKIE_FILE);
    } catch (err) {
      console.warn("[CookieJar] Failed to persist:", err instanceof Error ? err.message : err);
    }
  }

  private load(): void {
    try {
      if (!existsSync(COOKIE_FILE)) return;
      const raw = readFileSync(COOKIE_FILE, "utf-8");
      const data = JSON.parse(raw) as Record<string, Record<string, string>>;
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === "object" && val !== null) {
          this.cookies.set(key, val);
        }
      }
    } catch (err) {
      console.warn("[CookieJar] Failed to load cookies:", err instanceof Error ? err.message : err);
    }
  }

  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }
}
