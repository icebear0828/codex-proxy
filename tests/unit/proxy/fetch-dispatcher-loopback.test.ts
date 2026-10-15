import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

const mockGetConfig = vi.fn();

vi.mock("@src/config.js", () => ({
  getConfig: () => mockGetConfig(),
}));

describe("fetch dispatcher loopback bypass", () => {
  let localServer: Server;
  let localPort: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    await new Promise<void>((resolve) => {
      localServer = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "local-ok" }));
      });
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address() as AddressInfo;
        localPort = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      localServer.close(() => resolve());
    });
  });

  it("bypasses dead proxy for 127.0.0.1 and succeeds connecting to local server", async () => {
    // Point proxy to a dead port
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:59999" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const reqInit = withFetchDispatcher({ method: "GET" });
    const response = await fetch(`http://127.0.0.1:${localPort}/health`, reqInit);
    expect(response.ok).toBe(true);

    const body: unknown = await response.json();
    expect(body).toEqual({ status: "local-ok" });
  });

  it("bypasses dead proxy for localhost and succeeds connecting to local server", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:59999" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const reqInit = withFetchDispatcher({ method: "GET" });
    const response = await fetch(`http://localhost:${localPort}/health`, reqInit);
    expect(response.ok).toBe(true);

    const body: unknown = await response.json();
    expect(body).toEqual({ status: "local-ok" });
  });

  it("routes external request to dead proxy causing connection failure", async () => {
    mockGetConfig.mockReturnValue({ tls: { proxy_url: "http://127.0.0.1:59999" } });
    const { withFetchDispatcher } = await import("@src/proxy/fetch-dispatcher.js");

    const reqInit = withFetchDispatcher({ method: "GET" });
    // An external address that is not in no_proxy
    await expect(fetch("http://192.0.2.1/test", reqInit)).rejects.toThrow();
  });
});
