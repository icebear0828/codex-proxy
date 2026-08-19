import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "fs";
import type { ProxyRequest } from "../../../src/routes/shared/proxy-handler-types.js";

const testDataDir = `/tmp/codex-proxy-chat-default-tools-${process.pid}`;

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
    return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { createChatRoutes } from "../../../src/routes/chat.js";
import { AccountPool } from "../../../src/auth/account-pool.js";
import { ClientKeyPool } from "../../../src/auth/client-key-pool.js";
import { loadConfig } from "../../../src/config.js";
import { loadStaticModels, applyBackendModels } from "../../../src/models/model-store.js";

describe("Chat completions default_tools injection", () => {
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
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }]);
    accountPool = new AccountPool();
    vi.spyOn(accountPool, "isAuthenticated").mockReturnValue(true);
    vi.spyOn(accountPool, "getPoolSummary").mockReturnValue({
      total: 1,
      active: 1,
      rateLimited: 0,
      expired: 0,
      accounts: [],
    });

    clientKeyPool = new ClientKeyPool(undefined, () => "master-key-123");
    mockState.capturedReq = null;
  });

  it("auto-injects global default_tools into codexRequest when none provided by client", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const app = createChatRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "What is today's news?" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq).toBeTruthy();
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([{ type: "web_search" }]);
  });

  it("skips tool injection when X-Codex-Default-Tools: off header is sent", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const app = createChatRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
        "x-codex-default-tools": "off",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Tell me a joke" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([]);
  });

  it("overrides global default_tools with client access key default_tools", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const key = clientKeyPool.createKey({
      name: "Custom Tools Key",
      default_tools: ["image_generation"],
    });

    const app = createChatRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Generate an image" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([{ type: "image_generation" }]);
  });

  it("disables tool injection for client key configured with default_tools = []", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const key = clientKeyPool.createKey({
      name: "No Tools Key",
      default_tools: [],
    });

    const app = createChatRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.key}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "No tools please" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([]);
  });
});
