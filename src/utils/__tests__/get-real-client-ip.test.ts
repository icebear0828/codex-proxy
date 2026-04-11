import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type { AppConfig } from "../../config-schema.js";

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "127.0.0.1" } }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

import { getRealClientIp } from "../get-real-client-ip.js";

function makeConfig(trust_proxy: boolean): AppConfig {
  return { server: { trust_proxy, proxy_api_key: null, host: "0.0.0.0", port: 8080 } } as AppConfig;
}

function makeContext(headers: Record<string, string> = {}): Context {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as unknown as Context;
}

describe("getRealClientIp", () => {
  beforeEach(() => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
  });

  describe("trust_proxy = false (default)", () => {
    it("returns socket address regardless of X-Forwarded-For", () => {
      expect(getRealClientIp(makeContext({ "x-forwarded-for": "8.8.8.8" }), makeConfig(false))).toBe("127.0.0.1");
    });

    it("returns socket address regardless of X-Real-IP", () => {
      expect(getRealClientIp(makeContext({ "x-real-ip": "8.8.8.8" }), makeConfig(false))).toBe("127.0.0.1");
    });
  });

  describe("trust_proxy = true", () => {
    it("returns X-Forwarded-For first IP when present", () => {
      expect(getRealClientIp(makeContext({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }), makeConfig(true))).toBe("1.2.3.4");
    });

    it("returns X-Real-IP when no X-Forwarded-For", () => {
      expect(getRealClientIp(makeContext({ "x-real-ip": "5.6.7.8" }), makeConfig(true))).toBe("5.6.7.8");
    });

    it("falls back to socket address when no forwarded headers", () => {
      expect(getRealClientIp(makeContext({}), makeConfig(true))).toBe("127.0.0.1");
    });

    it("prefers X-Forwarded-For over X-Real-IP", () => {
      expect(getRealClientIp(makeContext({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }), makeConfig(true))).toBe("1.2.3.4");
    });

    it("falls back to socket when X-Forwarded-For is whitespace", () => {
      expect(getRealClientIp(makeContext({ "x-forwarded-for": "  " }), makeConfig(true))).toBe("127.0.0.1");
    });
  });
});
