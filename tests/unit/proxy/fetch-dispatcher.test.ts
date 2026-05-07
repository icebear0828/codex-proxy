import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetConfig = vi.fn();
const mockProxyAgent = vi.fn((url: string) => ({ proxyUrl: url }));

vi.mock("@src/config.js", () => ({
  getConfig: () => mockGetConfig(),
}));

vi.mock("undici", () => ({
  ProxyAgent: mockProxyAgent,
}));

describe("fetch dispatcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
  });

  it("does not add a dispatcher when no proxy is configured", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: null } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const init = { method: "POST" };

    expect(withFetchDispatcher(init)).toBe(init);
    expect(mockProxyAgent).not.toHaveBeenCalled();
  });

  it("adds a ProxyAgent dispatcher from tls.proxy_url", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:7890" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const init = { method: "POST" };
    const result = withFetchDispatcher(init);

    expect(result).not.toBe(init);
    expect(result.dispatcher).toEqual({ proxyUrl: "http://127.0.0.1:7890" });
    expect(mockProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:7890");
  });

  it("falls back to HTTPS_PROXY before config is loaded", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("Config not loaded");
    });
    process.env.HTTPS_PROXY = "http://127.0.0.1:7891";
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const result = withFetchDispatcher({ method: "POST" });

    expect(result.dispatcher).toEqual({ proxyUrl: "http://127.0.0.1:7891" });
    expect(mockProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:7891");
  });
});
