/**
 * Tests for CookieJar — per-account cookie storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

import { CookieJar } from "@src/proxy/cookie-jar.js";

describe("CookieJar", () => {
  let jar: CookieJar;

  beforeEach(() => {
    jar = new CookieJar();
  });

  afterEach(() => {
    jar.destroy();
  });

  describe("set + getCookieHeader", () => {
    it("sets cookies from string and gets header", () => {
      jar.set("acct1", "a=1; b=2");
      const header = jar.getCookieHeader("acct1");
      expect(header).toContain("a=1");
      expect(header).toContain("b=2");
    });

    it("sets cookies from Record", () => {
      jar.set("acct1", { foo: "bar", baz: "qux" });
      const header = jar.getCookieHeader("acct1");
      expect(header).toContain("foo=bar");
      expect(header).toContain("baz=qux");
    });

    it("returns null for unknown account", () => {
      expect(jar.getCookieHeader("unknown")).toBeNull();
    });

    it("merges with existing cookies", () => {
      jar.set("acct1", { a: "1" });
      jar.set("acct1", { b: "2" });
      const header = jar.getCookieHeader("acct1");
      expect(header).toContain("a=1");
      expect(header).toContain("b=2");
    });
  });

  describe("captureRaw", () => {
    it("parses Set-Cookie headers (whitelisted cookies only)", () => {
      jar.captureRaw("acct1", [
        "cf_clearance=xyz; Max-Age=3600; Path=/; HttpOnly",
      ]);
      const header = jar.getCookieHeader("acct1");
      expect(header).toContain("cf_clearance=xyz");
    });

    it("parses Max-Age for expiry", () => {
      // First write a valid cf_clearance, then a Max-Age=0 update should
      // immediately expire it. Both names must be whitelisted to exercise the
      // attribute parser.
      jar.captureRaw("acct1", ["cf_clearance=v1; Max-Age=3600"]);
      expect(jar.getCookieHeader("acct1")).toContain("cf_clearance=v1");
      jar.captureRaw("acct1", ["cf_clearance=v2; Max-Age=0"]);
      expect(jar.getCookieHeader("acct1")).toBeNull();
    });

    it("does nothing with empty array", () => {
      jar.captureRaw("acct1", []);
      expect(jar.getCookieHeader("acct1")).toBeNull();
    });

    it("filters out non-whitelisted cookies (e.g. __cf_bm)", () => {
      // __cf_bm is Cloudflare Bot Management — when captured and replayed it
      // becomes a "suspicious session" tag (bound to IP+UA+TLS at issue time)
      // and triggers path-level 404s on /codex/responses. Only cf_clearance
      // (the positive challenge-pass token) should be captured automatically.
      jar.captureRaw("acct1", [
        "__cf_bm=poison; Path=/; Max-Age=1800; HttpOnly",
        "cf_clearance=ok; Path=/; Max-Age=3600",
        "session_id=abc; Path=/; HttpOnly",
      ]);
      const raw = jar.get("acct1");
      expect(raw).not.toBeNull();
      expect(raw).not.toHaveProperty("__cf_bm");
      expect(raw).not.toHaveProperty("session_id");
      expect(raw).toEqual({ cf_clearance: "ok" });
    });

    it("manual set() still accepts arbitrary cookies (debugging / overrides)", () => {
      // The whitelist only applies to auto-capture from Set-Cookie headers.
      // Operators may still inject any cookie manually via the admin API.
      jar.set("acct1", { __cf_bm: "manual" });
      expect(jar.get("acct1")).toEqual({ __cf_bm: "manual" });
    });
  });

  describe("get", () => {
    it("returns raw cookie values", () => {
      jar.set("acct1", { a: "1", b: "2" });
      const raw = jar.get("acct1");
      expect(raw).toEqual({ a: "1", b: "2" });
    });

    it("returns null for unknown account", () => {
      expect(jar.get("unknown")).toBeNull();
    });
  });

  describe("clear", () => {
    it("clears all cookies for an account", () => {
      jar.set("acct1", { a: "1" });
      jar.clear("acct1");
      expect(jar.getCookieHeader("acct1")).toBeNull();
    });
  });
});
