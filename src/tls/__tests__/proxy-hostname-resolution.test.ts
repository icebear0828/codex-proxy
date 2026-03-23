import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dns/promises before importing the module
const mockLookup = vi.fn();
vi.mock("dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

vi.mock("fs", () => ({
  existsSync: () => false, // force system curl fallback
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("")),
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({
    tls: { curl_binary: "auto", proxy_url: null, force_http11: false },
  }),
}));

vi.mock("../../paths.js", () => ({
  getBinDir: () => "/nonexistent",
}));

// Mock net.createConnection for probePort
const mockCreateConnection = vi.fn();
vi.mock("net", () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
}));

describe("detectLocalProxy hostname resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLookup.mockReset();
    mockCreateConnection.mockReset();
  });

  /** Helper: simulate probePort — call connect callback or emit error */
  function setupProbe(results: Map<string, boolean>) {
    mockCreateConnection.mockImplementation((opts: { host: string; port: number }, cb: () => void) => {
      const key = `${opts.host}:${opts.port}`;
      const sock = {
        destroy: vi.fn(),
        setTimeout: vi.fn(),
        on: vi.fn((event: string, handler: () => void) => {
          if (event === "error" && !results.get(key)) {
            // Schedule error for non-matching hosts
            Promise.resolve().then(handler);
          }
          return sock;
        }),
      };
      if (results.get(key)) {
        // Simulate successful connection
        Promise.resolve().then(cb);
      }
      return sock;
    });
  }

  it("resolves host.docker.internal to IP when probe succeeds", async () => {
    // Only host.docker.internal:7890 responds
    setupProbe(new Map([["host.docker.internal:7890", true]]));
    mockLookup.mockResolvedValue({ address: "192.168.65.254", family: 4 });

    const { initProxy, getProxyUrl, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();

    // Reset _proxyUrl by re-running initProxy
    await initProxy();

    expect(mockLookup).toHaveBeenCalledWith("host.docker.internal");
    expect(getProxyUrl()).toBe("http://192.168.65.254:7890");
  });

  it("uses original hostname when DNS lookup fails", async () => {
    setupProbe(new Map([["host.docker.internal:7890", true]]));
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));

    const { initProxy, getProxyUrl, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();
    await initProxy();

    expect(getProxyUrl()).toBe("http://host.docker.internal:7890");
  });

  it("skips DNS resolution for IP addresses like 127.0.0.1", async () => {
    setupProbe(new Map([["127.0.0.1:7890", true]]));

    const { initProxy, getProxyUrl, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();
    await initProxy();

    expect(mockLookup).not.toHaveBeenCalled();
    expect(getProxyUrl()).toBe("http://127.0.0.1:7890");
  });
});
