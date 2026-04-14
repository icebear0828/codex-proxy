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
    it("parses Set-Cookie headers", () => {
      jar.captureRaw("acct1", [
        "session_id=abc123; Path=/; HttpOnly",
        "cf_clearance=xyz; Max-Age=3600",
      ]);
      const header = jar.getCookieHeader("acct1");
      expect(header).toContain("session_id=abc123");
      expect(header).toContain("cf_clearance=xyz");
    });

    it("parses Max-Age for expiry", () => {
      // Set a cookie with Max-Age=0 (immediately expired)
      jar.captureRaw("acct1", [
        "expired=val; Max-Age=0",
        "valid=val; Max-Age=3600",
      ]);
      const header = jar.getCookieHeader("acct1");
      expect(header).not.toContain("expired=");
      expect(header).toContain("valid=val");
    });

    it("does nothing with empty array", () => {
      jar.captureRaw("acct1", []);
      expect(jar.getCookieHeader("acct1")).toBeNull();
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
