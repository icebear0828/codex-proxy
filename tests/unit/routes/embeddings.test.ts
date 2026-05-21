/**
 * Tests for OpenAI-compatible embeddings proxying through runtime API keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import { createEmbeddingsRoutes } from "@src/routes/embeddings.js";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  tls: { proxy_url: null as string | null },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => {
      stored = [...keys];
    },
  };
}

function createAccountPool(validateProxyApiKey = true): AccountPool {
  return {
    validateProxyApiKey: vi.fn(() => validateProxyApiKey),
  } as unknown as AccountPool;
}

describe("embeddings routes", () => {
  let pool: ApiKeyPool;
  let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    mockConfig.server.proxy_api_key = null;
    pool = new ApiKeyPool(createMemoryPersistence());
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies embeddings to OpenAI-compatible runtime API keys", async () => {
    pool.add({
      provider: "custom",
      model: "text-embedding-3-small",
      apiKey: "upstream-secret",
      baseUrl: "https://embeddings.example.com/v1/",
      capabilities: ["embeddings"],
    });

    const app = createEmbeddingsRoutes(createAccountPool(), pool);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "hello",
        encoding_format: "float",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].embedding).toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://embeddings.example.com/v1/embeddings");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer upstream-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "text-embedding-3-small",
      input: "hello",
      encoding_format: "float",
    });
    expect(pool.getAll()[0].lastUsedAt).toBeTruthy();
  });

  it("requires the proxy API key when configured", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    pool.add({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "upstream-secret",
      capabilities: ["embeddings"],
    });

    const app = createEmbeddingsRoutes(createAccountPool(false), pool);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
    });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not use chat-only keys for embeddings", async () => {
    pool.add({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "chat-only-secret",
    });

    const app = createEmbeddingsRoutes(createAccountPool(), pool);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects embeddings-capable keys on providers without OpenAI-compatible embeddings", async () => {
    pool.add({
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-ant",
      capabilities: ["embeddings"],
    });

    const app = createEmbeddingsRoutes(createAccountPool(), pool);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6", input: "hello" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_provider");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed embedding requests", async () => {
    const app = createEmbeddingsRoutes(createAccountPool(), pool);
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });
});
