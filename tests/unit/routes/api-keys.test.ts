import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import { ApiKeyModelCache } from "@src/auth/api-key-model-cache.js";
import type { ApiKeyModelCacheFile, ApiKeyModelCachePersistence } from "@src/auth/api-key-model-cache.js";
import { createApiKeyRoutes } from "@src/routes/api-keys.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => {
      stored = [...keys];
    },
  };
}

function createModelPersistence(initial: ApiKeyModelCacheFile = { entries: {} }): ApiKeyModelCachePersistence & { snapshot(): ApiKeyModelCacheFile } {
  let stored = initial;
  return {
    load: () => ({ entries: { ...stored.entries } }),
    save: (cache) => {
      stored = { entries: { ...cache.entries } };
    },
    snapshot: () => stored,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api key routes", () => {
  let pool: ApiKeyPool;
  let modelPersistence: ReturnType<typeof createModelPersistence>;
  let fetchFn: ReturnType<typeof vi.fn<() => Promise<Response>>>;
  let app: ReturnType<typeof createApiKeyRoutes>;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
    modelPersistence = createModelPersistence();
    fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "model-a", name: "Model A" }] }));
    app = createApiKeyRoutes(pool, new ApiKeyModelCache({ persistence: modelPersistence, fetchFn }));
  });

  it("returns built-in catalog metadata with cached models", async () => {
    modelPersistence.save({
      entries: {
        "https://api.anthropic.com/v1/models": {
          url: "https://api.anthropic.com/v1/models",
          fetchedAt: new Date().toISOString(),
          models: [{ id: "claude-test", displayName: "Claude Test" }],
        },
      },
    });

    const res = await app.request("/auth/api-keys/catalog");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      catalog: {
        anthropic: {
          displayName: string;
          defaultBaseUrl: string;
          models: Array<{ id: string; displayName: string }>;
        };
      };
    };
    expect(body.catalog.anthropic.displayName).toBe("Anthropic");
    expect(body.catalog.anthropic.defaultBaseUrl).toContain("anthropic.com");
    expect(body.catalog.anthropic.models).toEqual([{ id: "claude-test", displayName: "Claude Test" }]);
  });

  it("fetches built-in provider models", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ models: [{ id: "model-a", displayName: "Model A" }] });
    expect(fetchFn).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer sk-openai", Accept: "application/json" },
    });
  });

  it("sends Anthropic version header when fetching Anthropic models", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant" }),
    });

    expect(res.status).toBe(200);
    expect(fetchFn.mock.calls[0][1]).toEqual({
      headers: {
        Authorization: "Bearer sk-ant",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  });

  it("uses Gemini query key while caching by URL without the key", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] }));

    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini", apiKey: "gem-key" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ models: [{ id: "gemini-test", displayName: "Gemini Test" }] });
    expect(String(fetchFn.mock.calls[0][0])).toContain("key=gem-key");
    expect(Object.keys(modelPersistence.snapshot().entries)).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
  });

  it("fetches custom provider models from base URL models endpoint", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", apiKey: "custom-key", baseUrl: "https://example.com/v1/" }),
    });

    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledWith("https://example.com/v1/models", {
      headers: { Authorization: "Bearer custom-key", Accept: "application/json" },
    });
  });

  it("uses URL-keyed cache for repeated model fetches", async () => {
    const body = JSON.stringify({ provider: "openai", apiKey: "sk-one" });
    const secondBody = JSON.stringify({ provider: "openai", apiKey: "sk-two" });

    await app.request("/auth/api-keys/models", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const res = await app.request("/auth/api-keys/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: secondBody });

    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns unauthorized errors from upstream", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ error: "no" }, 403));

    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai" }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch models: unauthorized" });
  });

  it("returns provider errors for empty model payloads", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai" }),
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Provider returned no models" });
  });

  it("adds one stored entry per selected model and masks returned keys", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4"],
        apiKey: "sk-1234567890abcdef",
        label: "Team",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, added: 2, failed: 0 });
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0].apiKey).toBe("sk-1****cdef");
    expect(pool.getAll().map((entry) => entry.model)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
    expect(pool.getAll().map((entry) => entry.capabilities)).toEqual([["chat"], ["chat"]]);
  });

  it("stores explicit capabilities for selected models", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["text-embedding-3-small"],
        apiKey: "sk-embedding",
        capabilities: ["embeddings"],
      }),
    });

    expect(res.status).toBe(200);
    expect(pool.getAll()[0].capabilities).toEqual(["embeddings"]);
  });

  it("requires baseUrl for custom provider keys", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        models: ["custom-model"],
        apiKey: "secret",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("imports keys by expanding each entry's models", async () => {
    const res = await app.request("/auth/api-keys/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: [
          {
            provider: "anthropic",
            models: ["claude-opus-4-6", "claude-sonnet-4-6"],
            apiKey: "sk-ant",
            label: null,
          },
          {
            provider: "custom",
            models: ["custom-a"],
            apiKey: "custom-key",
            baseUrl: "https://example.com/v1",
            capabilities: ["chat", "embeddings"],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, added: 3, failed: 0 });
    expect(pool.getAll().map((entry) => entry.model)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "custom-a",
    ]);
    expect(pool.getAll()[2].capabilities).toEqual(["chat", "embeddings"]);
  });

  it("exports stored single-model entries as importable multi-model entries", async () => {
    pool.add({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "sk-openai",
      label: "A",
      capabilities: ["chat", "embeddings"],
    });

    const res = await app.request("/auth/api-keys/export");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toEqual([
      {
        provider: "openai",
        models: ["gpt-5.4"],
        apiKey: "sk-openai",
        baseUrl: "https://api.openai.com/v1",
        label: "A",
        capabilities: ["chat", "embeddings"],
        wire: "chat",
      },
    ]);
  });

  it("batch deletes existing ids and ignores missing ids", async () => {
    const first = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    const second = pool.add({ provider: "openai", model: "gpt-5.4-mini", apiKey: "k2" });

    const res = await app.request("/auth/api-keys/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [first.id, "missing", second.id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: 2 });
    expect(pool.getAll()).toHaveLength(0);
  });
});
