import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "fs";
import type { ProxyRequest } from "../../../src/routes/shared/proxy-handler-types.js";

const testDataDir = `/tmp/codex-proxy-messages-default-tools-${process.pid}`;

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
    return new Response(JSON.stringify({ id: "msg_test", content: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { createMessagesRoutes } from "../../../src/routes/messages.js";
import { AccountPool } from "../../../src/auth/account-pool.js";
import { loadConfig } from "../../../src/config.js";
import { loadStaticModels, applyBackendModels } from "../../../src/models/model-store.js";

describe("Messages default_tools injection", () => {
  let accountPool: AccountPool;

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const config = loadConfig();
    config.server.proxy_api_key = "master-key-123";
    config.model.default_tools = [];
    loadStaticModels();
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }]);
    accountPool = new AccountPool();
    vi.spyOn(accountPool, "isAuthenticated").mockReturnValue(true);
    mockState.capturedReq = null;
  });

  it("preserves the existing hosted web_search fallback when global defaults are empty", async () => {
    const app = createMessagesRoutes(accountPool);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "master-key-123",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Search the web" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([{ type: "web_search" }]);
  });

  it("allows the request header to opt out of the hosted web_search fallback", async () => {
    const app = createMessagesRoutes(accountPool);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "master-key-123",
        "x-codex-default-tools": "off",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Do not search" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([]);
  });
});
