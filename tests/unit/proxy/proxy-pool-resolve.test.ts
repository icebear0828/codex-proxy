import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock persistence so ProxyPool doesn't touch the filesystem
vi.mock("@src/paths.js", () => ({
  getDataDir: () => "/tmp/proxy-pool-test-" + process.pid,
}));
vi.mock("@src/tls/transport.js", () => ({
  getTransport: () => ({}),
}));

import { ProxyPool } from "@src/proxy/proxy-pool.js";

describe("ProxyPool.resolveProxyUrl", () => {
  let pool: ProxyPool;
  let proxyId: string;

  beforeEach(() => {
    pool = new ProxyPool();
    proxyId = pool.add("test-http", "http://proxy.local:870");
  });

  it("returns proxy URL when assigned and active", () => {
    pool.assign("account-1", proxyId);
    expect(pool.resolveProxyUrl("account-1")).toBe("http://proxy.local:870");
  });

  it("returns proxy URL even when status is unreachable", () => {
    pool.assign("account-1", proxyId);
    // Simulate health check failure marking it unreachable
    const entry = pool.getById(proxyId)!;
    entry.status = "unreachable";

    // Should still use the explicitly assigned proxy, not fall back to global
    expect(pool.resolveProxyUrl("account-1")).toBe("http://proxy.local:870");
  });

  it("falls back to global when unreachable and skipUnhealthy is true", () => {
    pool.assign("account-1", proxyId);
    const entry = pool.getById(proxyId)!;
    entry.status = "unreachable";

    expect(pool.resolveProxyUrl("account-1", true)).toBeUndefined();
  });

  it("falls back to global (undefined) when proxy is manually disabled", () => {
    pool.assign("account-1", proxyId);
    pool.disable(proxyId);
    expect(pool.resolveProxyUrl("account-1")).toBeUndefined();
  });

  it("falls back to global (undefined) when proxy is deleted", () => {
    pool.assign("account-1", proxyId);
    pool.remove(proxyId);
    // Assignment cleaned up on remove, so it falls back to global
    expect(pool.resolveProxyUrl("account-1")).toBeUndefined();
  });

  it("returns undefined (global) for unassigned accounts", () => {
    expect(pool.resolveProxyUrl("unknown-account")).toBeUndefined();
  });

  it("returns null (direct) for 'direct' assignment", () => {
    pool.assign("account-1", "direct");
    expect(pool.resolveProxyUrl("account-1")).toBeNull();
  });

  // ── resolveProxyUrlById ───────────────────────────────────────

  it("resolves proxy URL directly by proxyId", () => {
    expect(pool.resolveProxyUrlById("direct")).toBeNull();
    expect(pool.resolveProxyUrlById("global")).toBeUndefined();
    expect(pool.resolveProxyUrlById(undefined)).toBeUndefined();
    expect(pool.resolveProxyUrlById(null)).toBeUndefined();
    expect(pool.resolveProxyUrlById(proxyId)).toBe("http://proxy.local:870");

    expect(pool.resolveProxyUrlById("auto")).toBe("http://proxy.local:870");

    pool.disable(proxyId);
    expect(pool.resolveProxyUrlById(proxyId)).toBeUndefined();
  });

  it("returns display name for proxy assignments including null/global", () => {
    expect(pool.getProxyDisplayName(null)).toBe("Global Default");
    expect(pool.getProxyDisplayName(undefined)).toBe("Global Default");
    expect(pool.getProxyDisplayName("global")).toBe("Global Default");
    expect(pool.getProxyDisplayName("direct")).toBe("Direct (No Proxy)");
    expect(pool.getProxyDisplayName("auto")).toBe("Auto (Round-Robin)");
    expect(pool.getProxyDisplayName(proxyId)).toBe("test-http");
  });
});
