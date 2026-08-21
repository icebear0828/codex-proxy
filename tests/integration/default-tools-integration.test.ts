import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { ProxyRequest } from "../../src/routes/shared/proxy-handler-types.js";

const integrationDataDir = `/tmp/codex-proxy-default-tools-integration-${process.pid}`;

vi.mock("../../src/paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/paths.js")>();
  return { ...original, getDataDir: () => integrationDataDir };
});

const mockState = vi.hoisted(() => ({
  lastCapturedReq: null as ProxyRequest | null,
}));

vi.mock("../../src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (opts: { req: ProxyRequest }) => {
    mockState.lastCapturedReq = opts.req;
    return new Response(JSON.stringify({ id: "resp-mock", choices: [{ message: { content: "OK" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

import { Hono } from "hono";
import { loadConfig } from "../../src/config.js";
import { loadStaticModels, applyBackendModels } from "../../src/models/model-store.js";
import { ClientKeyPool } from "../../src/auth/client-key-pool.js";
import { ClientKeyPersistence } from "../../src/auth/client-key-persistence.js";
import { createClientKeyAdminRoutes } from "../../src/routes/admin/client-keys.js";
import { createChatRoutes } from "../../src/routes/chat.js";
import { createResponsesRoutes } from "../../src/routes/responses.js";
import { createGeminiRoutes } from "../../src/routes/gemini.js";
import { createMessagesRoutes } from "../../src/routes/messages.js";
import { AccountPool } from "../../src/auth/account-pool.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Default Tools Integration Workflow", () => {
  let tempDir: string;
  let pool: ClientKeyPool;
  let app: Hono;
  const MASTER_KEY = "master-secret-for-default-tools-e2e";

  beforeAll(() => {
    const config = loadConfig();
    config.server.proxy_api_key = MASTER_KEY;
    loadStaticModels();
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }, { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    tempDir = mkdtempSync(join(tmpdir(), "default-tools-integration-"));
    const persistence = new ClientKeyPersistence(
      join(tempDir, "client-keys.sqlite"),
      join(tempDir, "client-keys.json"),
    );
    pool = new ClientKeyPool(persistence, () => MASTER_KEY);

    const accountPool = new AccountPool();
    vi.spyOn(accountPool, "isAuthenticated").mockReturnValue(true);
    vi.spyOn(accountPool, "getPoolSummary").mockReturnValue({
      total: 1,
      active: 1,
      rateLimited: 0,
      expired: 0,
      accounts: [],
    });

    app = new Hono();
    app.route("/", createClientKeyAdminRoutes(pool, () => MASTER_KEY));
    app.route("/", createChatRoutes(accountPool, undefined, undefined, undefined, pool));
    app.route("/", createResponsesRoutes(accountPool, undefined, undefined, undefined, pool));
    app.route("/", createGeminiRoutes(accountPool, undefined, undefined, undefined, pool));
    app.route("/", createMessagesRoutes(accountPool, undefined, undefined, undefined, pool));
  });

  afterAll(async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(integrationDataDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it("verifies global default_tools, per-key overrides, and opt-out header across ≥ 3 consecutive requests", async () => {
    const config = loadConfig();
    config.model.default_tools = ["web_search"];

    // 1. Create client keys with custom default_tools and default_tools = []
    const keyWithImageGenRes = await app.request("/admin/client-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ImageGen Key",
        default_tools: ["image_generation"],
      }),
    });
    expect(keyWithImageGenRes.status).toBe(200);
    const keyWithImageGen = (await keyWithImageGenRes.json()).key.key;

    const keyWithNoToolsRes = await app.request("/admin/client-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "No Tools Key",
        default_tools: [],
      }),
    });
    expect(keyWithNoToolsRes.status).toBe(200);
    const keyWithNoTools = (await keyWithNoToolsRes.json()).key.key;

    // 2. ≥ 3 Consecutive calls with global default_tools on /v1/chat/completions
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MASTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `Search test iteration ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([{ type: "web_search" }]);
      console.log(`[Integration] Iteration ${i} /v1/chat/completions (Global default_tools) -> SUCCESS (Injected: web_search)`);
    }

    // 3. ≥ 3 Consecutive calls with per-key override (image_generation)
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyWithImageGen}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `Image gen iteration ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([{ type: "image_generation" }]);
      console.log(`[Integration] Iteration ${i} /v1/chat/completions (Client Key image_generation) -> SUCCESS`);
    }

    // 4. ≥ 3 Consecutive calls with per-key disabled (default_tools = [])
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyWithNoTools}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `No tools iteration ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([]);
      console.log(`[Integration] Iteration ${i} /v1/chat/completions (Client Key disabled tools) -> SUCCESS`);
    }

    // 5. ≥ 3 Consecutive calls with header opt-out (X-Codex-Default-Tools: off)
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MASTER_KEY}`,
          "Content-Type": "application/json",
          "X-Codex-Default-Tools": "off",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `Opt out header iteration ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([]);
      console.log(`[Integration] Iteration ${i} /v1/chat/completions (Header opt-out) -> SUCCESS`);
    }

    // 6. ≥ 3 Consecutive calls with Anthropic endpoint (/v1/messages) respecting client key disabled tools
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": keyWithNoTools,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `Anthropic disabled tools iteration ${i}` }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([]);
      console.log(`[Integration] Iteration ${i} /v1/messages (Client Key disabled tools) -> SUCCESS`);
    }

    // 7. ≥ 3 Consecutive calls with Anthropic endpoint (/v1/messages) preserving specific variant (e.g. web_search_preview)
    config.model.default_tools = ["web_search_preview"];
    for (let i = 1; i <= 3; i++) {
      mockState.lastCapturedReq = null;
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": MASTER_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: `Anthropic custom search iteration ${i}` }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(200);
      expect(mockState.lastCapturedReq?.codexRequest.tools).toEqual([{ type: "web_search_preview" }]);
      console.log(`[Integration] Iteration ${i} /v1/messages (web_search_preview preserved) -> SUCCESS`);
    }
  });
});
