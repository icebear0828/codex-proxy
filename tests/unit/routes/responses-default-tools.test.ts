import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProxyRequest } from "../../../src/routes/shared/proxy-handler-types.js";

const mockState = vi.hoisted(() => ({
  capturedReq: null as ProxyRequest | null,
}));

vi.mock("../../../src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (opts: { req: ProxyRequest }) => {
    mockState.capturedReq = opts.req;
    return new Response(JSON.stringify({ id: "resp_123", object: "response" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { createResponsesRoutes } from "../../../src/routes/responses.js";
import { AccountPool } from "../../../src/auth/account-pool.js";
import { ClientKeyPool } from "../../../src/auth/client-key-pool.js";
import { loadConfig } from "../../../src/config.js";
import { loadStaticModels, applyBackendModels } from "../../../src/models/model-store.js";

describe("Responses default_tools injection", () => {
  let accountPool: AccountPool;
  let clientKeyPool: ClientKeyPool;

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

    const app = createResponsesRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: "What is today's news?" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq).toBeTruthy();
    expect(mockState.capturedReq?.codexRequest.tools).toEqual([{ type: "web_search" }]);
  });

  it("skips tool injection when X-Codex-Default-Tools: off header is sent", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    const app = createResponsesRoutes(accountPool, undefined, undefined, undefined, clientKeyPool);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer master-key-123",
        "x-codex-default-tools": "off",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: "Tell me a joke" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockState.capturedReq?.codexRequest.tools).toBeUndefined();
  });
});
