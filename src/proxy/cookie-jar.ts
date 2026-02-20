/**
 * CookieJar — per-account cookie storage.
 *
 * Stores cookies (especially cf_clearance from Cloudflare) so that
 * GET endpoints like /codex/usage don't get blocked by JS challenges.
 *
 * Cookies are auto-captured from every ChatGPT API response's Set-Cookie
 * headers, and can also be set manually via the management API.
 *
 * Persistence format v2: includes expiry timestamps.
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

interface StoredCookie {
  value: string;
  expires: number | null; // Unix ms timestamp, null = session cookie
}

/** v2 persistence format */
interface CookieFileV2 {
  _version: 2;
  accounts: Record<string, Record<string, { value: string; expires: number | null }>>;
}

/** Critical cookie names that trigger immediate persistence on change */
const CRITICAL_COOKIES = new Set(["cf_clearance", "__cf_bm"]);

export class CookieJar {
  private cookies: Map<string, Record<string, StoredCookie>> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.load();
    this.cleanupExpired();
    // Clean up expired cookies every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
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
        if (name) existing[name] = { value, expires: null };
      }
    } else {
      for (const [k, v] of Object.entries(cookies)) {
        existing[k] = { value: v, expires: null };
      }
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
    const now = Date.now();
    const pairs: string[] = [];
    for (const [k, c] of Object.entries(cookies)) {
      if (c.expires !== null && c.expires <= now) continue; // skip expired
      pairs.push(`${k}=${c.value}`);
    }
    return pairs.length > 0 ? pairs.join("; ") : null;
  }

  /**
   * Auto-capture Set-Cookie headers from an API response.
   * Call this after every successful fetch to chatgpt.com.
   */
  capture(accountId: string, response: Response): void {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    this.captureRaw(accountId, setCookies);
  }

  /**
   * Capture cookies from raw Set-Cookie header strings (e.g. from curl).
   */
  captureRaw(accountId: string, setCookies: string[]): void {
    if (setCookies.length === 0) return;

    const existing = this.cookies.get(accountId) ?? {};
    let changed = false;
    let hasCritical = false;

    for (const raw of setCookies) {
      const parts = raw.split(";").map((s) => s.trim());
      const pair = parts[0];
      const eq = pair.indexOf("=");
      if (eq === -1) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;

      // Parse expiry from attributes
      let expires: number | null = null;
      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i];
        const attrLower = attr.toLowerCase();
        if (attrLower.startsWith("max-age=")) {
          const seconds = parseInt(attr.slice(8), 10);
          if (!isNaN(seconds)) {
            expires = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
          }
          break; // Max-Age takes precedence over Expires
        }
        if (attrLower.startsWith("expires=")) {
          const date = new Date(attr.slice(8));
          if (!isNaN(date.getTime())) {
            expires = date.getTime();
          }
        }
      }

      const prev = existing[name];
      if (!prev || prev.value !== value || prev.expires !== expires) {
        existing[name] = { value, expires };
        changed = true;
        if (CRITICAL_COOKIES.has(name)) hasCritical = true;
      }
    }

    if (changed) {
      this.cookies.set(accountId, existing);
      if (hasCritical) {
        this.persistNow(); // Critical cookie — persist immediately
      } else {
        this.schedulePersist();
      }
    }
  }

  /** Get raw cookie record for an account. */
  get(accountId: string): Record<string, string> | null {
    const cookies = this.cookies.get(accountId);
    if (!cookies) return null;
    const result: Record<string, string> = {};
    for (const [k, c] of Object.entries(cookies)) {
      result[k] = c.value;
    }
    return result;
  }

  /** Clear all cookies for an account. */
  clear(accountId: string): void {
    if (this.cookies.delete(accountId)) {
      this.schedulePersist();
    }
  }

  /** Remove expired cookies from all accounts. */
  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [, cookies] of this.cookies) {
      for (const [name, c] of Object.entries(cookies)) {
        if (c.expires !== null && c.expires <= now) {
          delete cookies[name];
          changed = true;
        }
      }
    }
    if (changed) this.schedulePersist();
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

      // Persist v2 format with expiry info
      const data: CookieFileV2 = { _version: 2, accounts: {} };
      for (const [acct, cookies] of this.cookies) {
        data.accounts[acct] = {};
        for (const [k, c] of Object.entries(cookies)) {
          data.accounts[acct][k] = { value: c.value, expires: c.expires };
        }
      }
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
      const data = JSON.parse(raw);

      if (data && data._version === 2 && data.accounts) {
        // v2 format: { _version: 2, accounts: { acct: { name: { value, expires } } } }
        for (const [acct, cookies] of Object.entries(data.accounts as Record<string, Record<string, { value: string; expires: number | null }>>)) {
          const record: Record<string, StoredCookie> = {};
          for (const [k, c] of Object.entries(cookies)) {
            record[k] = { value: c.value, expires: c.expires ?? null };
          }
          this.cookies.set(acct, record);
        }
      } else {
        // v1 format: { acct: { name: "value" } } (no expiry)
        for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
          if (key === "_version") continue;
          if (typeof val === "object" && val !== null) {
            const record: Record<string, StoredCookie> = {};
            for (const [k, v] of Object.entries(val as Record<string, string>)) {
              record[k] = { value: v, expires: null };
            }
            this.cookies.set(key, record);
          }
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
    clearInterval(this.cleanupTimer);
    this.persistNow();
  }
}
