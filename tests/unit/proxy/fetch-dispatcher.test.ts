import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetConfig = vi.fn();
interface MockEnvHttpProxyOptions {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}
const mockEnvHttpProxyAgent = vi.fn((opts: MockEnvHttpProxyOptions) => ({ opts }));

vi.mock("@src/config.js", () => ({
  getConfig: () => mockGetConfig(),
}));

vi.mock("undici", () => ({
  EnvHttpProxyAgent: mockEnvHttpProxyAgent,
}));

describe("fetch dispatcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  it("does not add a dispatcher when no proxy is configured", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: null } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const init = { method: "POST" };

    expect(withFetchDispatcher(init)).toBe(init);
    expect(mockEnvHttpProxyAgent).not.toHaveBeenCalled();
  });

  it("adds an EnvHttpProxyAgent dispatcher with default loopback bypass from tls.proxy_url", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:7890" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const init = { method: "POST" };
    const result = withFetchDispatcher(init);

    expect(result).not.toBe(init);
    expect(result.dispatcher).toEqual({
      opts: {
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1,::1",
      },
    });
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1,::1",
    });
  });

  it("merges custom NO_PROXY environment variable with default loopback addresses", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:7890" } });
    process.env.NO_PROXY = "example.com,192.168.1.0/24";
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const result = withFetchDispatcher({ method: "POST" });

    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1,::1,example.com,192.168.1.0/24",
    });
  });

  it("falls back to HTTPS_PROXY before config is loaded", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("Config not loaded");
    });
    process.env.HTTPS_PROXY = "http://127.0.0.1:7891";
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const result = withFetchDispatcher({ method: "POST" });

    expect(result.dispatcher).toEqual({
      opts: {
        httpProxy: "http://127.0.0.1:7891",
        httpsProxy: "http://127.0.0.1:7891",
        noProxy: "localhost,127.0.0.1,::1",
      },
    });
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://127.0.0.1:7891",
      httpsProxy: "http://127.0.0.1:7891",
      noProxy: "localhost,127.0.0.1,::1",
    });
  });

  it("returns undefined dispatcher when null is explicitly passed (direct connection)", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:7890" } });
    const { withFetchDispatcher, getFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    expect(getFetchDispatcher(null)).toBeUndefined();
    const init = { method: "POST" };
    expect(withFetchDispatcher(init, null)).toBe(init);
  });

  it("creates a custom dispatcher for a specific proxy URL", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:7890" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const init = { method: "POST" };
    const result = withFetchDispatcher(init, "http://node-proxy.local:9000");

    expect(result.dispatcher).toEqual({
      opts: {
        httpProxy: "http://node-proxy.local:9000",
        httpsProxy: "http://node-proxy.local:9000",
        noProxy: "localhost,127.0.0.1,::1",
      },
    });
  });
});

