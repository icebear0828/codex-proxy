import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "fs";
import type { ProxyRequest } from "../../../src/routes/shared/proxy-handler-types.js";

const testDataDir = `/tmp/codex-proxy-gemini-default-tools-${process.pid}`;

vi.mock("../../../src/paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/paths.js")>();
  return { ...original, getDataDir: () => testDataDir };
});

const mockState = vi.hoisted(() => ({
  capturedReq: null as ProxyRequest | null,
}));

vi.mock("../../../src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (opts: { req: ProxyRequest }) => {
    mockState.capturedReq = opts.req;
    return new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { createGeminiRoutes } from "../../../src/routes/gemini.js";
import { AccountPool } from "../../../src/auth/account-pool.js";
import { ClientKeyPool } from "../../../src/auth/client-key-pool.js";
import { loadConfig } from "../../../src/config.js";
import { loadStaticModels, applyBackendModels } from "../../../src/models/model-store.js";

describe("Gemini default_tools injection", () => {
  let accountPool: AccountPool;
  let clientKeyPool: ClientKeyPool;

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const config = loadConfig();
    config.server.proxy_api_key = "master-key-123";
    loadStaticModels();
    applyBackendModels([{ slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    accountPool = new AccountPool();
    vi.spyOn(accountPool, "isAuthenticated").mockReturnValue(true);

    clientKeyPool = new ClientKeyPool(undefined, () => "master-key-123");
    mockState.capturedReq = null;
  });

  it("auto-injects global default_tools into Gemini requests", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const app = createGeminiRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What is today's news?" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq).toBeTruthy();
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([{ type: "web_search" }]);
  });

  it("marks globally injected image_generation as an image request", async () => {
    const config = loadConfig();
    config.model.default_tools = ["image_generation"];

    const app = createGeminiRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Generate an image" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.expectsImageGen).toBe(true);
  });

  it("skips tool injection when X-Codex-Default-Tools: off header is sent", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const app = createGeminiRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
        "x-codex-default-tools": "off",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Tell me a joke" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([]);
  });
});
