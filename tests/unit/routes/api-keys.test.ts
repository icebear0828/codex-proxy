import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import { ApiKeyModelCache } from "@src/auth/api-key-model-cache.js";
import type { ApiKeyModelCacheFile, ApiKeyModelCachePersistence } from "@src/auth/api-key-model-cache.js";
import { ApiKeyMemoStore } from "@src/auth/api-key-memo-store.js";
import type { ApiKeyMemoPersistence } from "@src/auth/api-key-memo-store.js";
import { createApiKeyRoutes } from "@src/routes/api-keys.js";

function createMemoryMemoPersistence(): ApiKeyMemoPersistence {
  let stored: ReturnType<ApiKeyMemoStore["list"]> = [];
  return {
    load: () => ({ memos: stored.map((m) => ({ ...m })) }),
    save: (memos) => {
      stored = memos.map((m) => ({ ...m }));
    },
  };
}

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
    app = createApiKeyRoutes(pool, new ApiKeyModelCache({ persistence: modelPersistence, fetchFn }), new ApiKeyMemoStore(createMemoryMemoPersistence()));
  });

  it("returns built-in catalog metadata without token-scoped cache models", async () => {
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
    expect(body.catalog.anthropic.models).not.toEqual([{ id: "claude-test", displayName: "Claude Test" }]);
    expect(body.catalog.anthropic.models.length).toBeGreaterThan(0);
  });

  it("fetches built-in provider models", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ models: [{ id: "model-a", displayName: "Model A" }], fromCache: false, stale: false });
    expect(fetchFn).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer sk-openai", Accept: "application/json" },
    });
  });

  it("sends Anthropic API-key and version headers when fetching Anthropic models", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant" }),
    });

    expect(res.status).toBe(200);
    expect(fetchFn.mock.calls[0][1]).toEqual({
      headers: {
        "x-api-key": "sk-ant",
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
    await expect(res.json()).resolves.toMatchObject({ models: [{ id: "gemini-test", displayName: "Gemini Test" }] });
    expect(String(fetchFn.mock.calls[0][0])).toContain("key=gem-key");
    expect(Object.keys(modelPersistence.snapshot().entries)).toEqual([
      expect.stringMatching(/https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models#provider=gemini&wire=gemini&key=[0-9a-f]{64}/),
    ]);
  });

  it("rejects custom-only wires when fetching built-in provider models", async () => {
    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai", wire: "gemini" }),
    });

    expect(res.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
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

  it("fetches custom Anthropic-format models when wire is anthropic", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-custom", display_name: "Claude Custom" }] }));

    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        apiKey: "custom-ant",
        baseUrl: "https://anthropic.example.com/v1/",
        wire: "anthropic",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ models: [{ id: "claude-custom", displayName: "Claude Custom" }] });
    expect(fetchFn).toHaveBeenCalledWith("https://anthropic.example.com/v1/models", {
      headers: {
        "x-api-key": "custom-ant",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  });

  it("fetches custom Gemini-format models when wire is gemini", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-custom", displayName: "Gemini Custom" }] }));

    const res = await app.request("/auth/api-keys/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        apiKey: "custom-gem",
        baseUrl: "https://gemini.example.com/v1beta/",
        wire: "gemini",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ models: [{ id: "gemini-custom", displayName: "Gemini Custom" }] });
    expect(String(fetchFn.mock.calls[0][0])).toBe("https://gemini.example.com/v1beta/models?key=custom-gem");
    expect(fetchFn.mock.calls[0][1]).toEqual({ headers: { Accept: "application/json" } });
    expect(Object.keys(modelPersistence.snapshot().entries)).toEqual([
      expect.stringMatching(/https:\/\/gemini\.example\.com\/v1beta\/models#provider=custom&wire=gemini&key=[0-9a-f]{64}/),
    ]);
  });

  it("does not reuse model cache entries for different API keys", async () => {
    const body = JSON.stringify({ provider: "openai", apiKey: "sk-one" });
    const secondBody = JSON.stringify({ provider: "openai", apiKey: "sk-two" });

    await app.request("/auth/api-keys/models", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const res = await app.request("/auth/api-keys/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: secondBody });

    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

  it("rejects custom-only wires for built-in providers", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.4"],
        apiKey: "sk-openai",
        wire: "gemini",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("rejects baseUrl for built-in providers", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        models: ["claude-test"],
        apiKey: "sk-ant",
        baseUrl: "https://wrong.example.com/v1",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("stores custom Anthropic and Gemini wire values", async () => {
    const anthropicRes = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        models: ["claude-custom"],
        apiKey: "custom-ant",
        baseUrl: "https://anthropic.example.com/v1",
        wire: "anthropic",
      }),
    });
    const geminiRes = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        models: ["gemini-custom"],
        apiKey: "custom-gem",
        baseUrl: "https://gemini.example.com/v1beta",
        wire: "gemini",
      }),
    });

    expect(anthropicRes.status).toBe(200);
    expect(geminiRes.status).toBe(200);
    expect(pool.getAll().map((entry) => entry.wire)).toEqual(["anthropic", "gemini"]);
  });

  it("stores the custom Codex Responses wire value", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        models: ["gpt-5.6-sol"],
        apiKey: "vendor-key",
        baseUrl: "https://provider.example.com/v1",
        wire: "codex-responses",
      }),
    });

    expect(res.status).toBe(200);
    expect(pool.getAll()[0]).toMatchObject({
      provider: "custom",
      model: "gpt-5.6-sol",
      baseUrl: "https://provider.example.com/v1",
      wire: "codex-responses",
    });
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
        label: "A",
        capabilities: ["chat", "embeddings"],
        wire: "chat",
      },
    ]);
  });

  it("imports and exports custom native wire values", async () => {
    const importRes = await app.request("/auth/api-keys/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: [
          {
            provider: "custom",
            models: ["claude-custom"],
            apiKey: "custom-ant",
            baseUrl: "https://anthropic.example.com/v1",
            wire: "anthropic",
          },
          {
            provider: "custom",
            models: ["gemini-custom"],
            apiKey: "custom-gem",
            baseUrl: "https://gemini.example.com/v1beta",
            wire: "gemini",
          },
        ],
      }),
    });

    expect(importRes.status).toBe(200);
    const res = await app.request("/auth/api-keys/export");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toEqual([
      expect.objectContaining({
        provider: "custom",
        models: ["claude-custom"],
        baseUrl: "https://anthropic.example.com/v1",
        wire: "anthropic",
      }),
      expect.objectContaining({
        provider: "custom",
        models: ["gemini-custom"],
        baseUrl: "https://gemini.example.com/v1beta",
        wire: "gemini",
      }),
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

  // ── Memos ───────────────────────────────────────────────────────

  let memoId: string;

  beforeEach(async () => {
    const res = await app.request("/auth/api-keys/memos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        apiKey: "sk-memo-key",
        baseUrl: "https://example.com/v1",
        wire: "codex-responses",
        capabilities: ["chat"],
      }),
    });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("sk-memo-key");
    expect(body.memo).not.toHaveProperty("apiKey");
    memoId = body.memo.id;
  });

  it("lists memos", async () => {
    const res = await app.request("/auth/api-keys/memos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memos).toHaveLength(1);
    expect(body.memos[0]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-memo-key");
  });

  it("clears a memo model snapshot when its key changes", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-6", name: "GPT 6" }] }));
    await app.request(`/auth/api-keys/memos/${memoId}/models?force=1`, { method: "POST" });

    const res = await app.request(`/auth/api-keys/memos/${memoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-updated-key" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memo).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-updated-key");
    expect(body.memo.models).toEqual([]);
    expect(body.memo.modelsFetchedAt).toBeNull();
  });

  it("adds entries from a memo without sending the key", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", models: ["gpt-6"], baseUrl: "https://example.com/v1", wire: "codex-responses", memoId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(pool.getAll()[0].apiKey).toBe("sk-memo-key");
    expect(pool.getAll()[0].label).toBeTruthy();
  });

  it("skips (model, key) pairs that already exist while allowing other keys", async () => {
    pool.add({ provider: "custom", model: "gpt-6", apiKey: "sk-memo-key", baseUrl: "https://example.com/v1", wire: "codex-responses" });

    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", models: ["gpt-6", "gpt-5.6"], memoId }),
    });

    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.duplicates).toBe(1);
    expect(pool.getAll().map((entry) => entry.model)).toEqual(["gpt-6", "gpt-5.6"]);
  });

  it("reports 404 for an unknown memoId", async () => {
    const res = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", models: ["m"], baseUrl: "https://example.com/v1", memoId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("refreshes memo models with the stored key and stores the snapshot", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-6", name: "GPT 6" }] }));

    const res = await app.request(`/auth/api-keys/memos/${memoId}/models?force=1`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledWith("https://example.com/v1/models", {
      headers: { Authorization: "Bearer sk-memo-key", Accept: "application/json" },
    });
    const body = await res.json();
    expect(body.models).toEqual([{ id: "gpt-6", displayName: "GPT 6" }]);
    expect(body.memo.modelsFetchedAt).toBeTruthy();
    expect(body.memo).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-memo-key");
  });

  it("reports coverage and hides the generator when fully covered", async () => {
    pool.add({ provider: "custom", model: "gpt-6", apiKey: "sk-memo-key", baseUrl: "https://example.com/v1", wire: "codex-responses" });

    const covered = await (await app.request("/auth/api-keys/memos/coverage")).json();
    expect(covered.canGenerate).toBe(false);

    pool.add({ provider: "custom", model: "other", apiKey: "sk-uncovered", baseUrl: "https://other.com/v1", wire: "chat" });
    const uncovered = await (await app.request("/auth/api-keys/memos/coverage")).json();
    expect(uncovered.canGenerate).toBe(true);
    expect(uncovered.uncovered).toBe(1);

    const genResponse = await app.request("/auth/api-keys/memos/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const gen = await genResponse.json();
    expect(gen.created).toBe(1);
    expect(JSON.stringify(gen)).not.toContain("sk-memo-key");
    expect(JSON.stringify(gen)).not.toContain("sk-uncovered");
    expect(gen.memos.every((memo: Record<string, unknown>) => !Object.hasOwn(memo, "apiKey"))).toBe(true);
    const after = await (await app.request("/auth/api-keys/memos/coverage")).json();
    expect(after.canGenerate).toBe(false);
  });

  it("deletes a memo without touching pool entries", async () => {
    pool.add({ provider: "custom", model: "gpt-6", apiKey: "sk-memo-key", baseUrl: "https://example.com/v1", wire: "codex-responses" });

    const res = await app.request(`/auth/api-keys/memos/${memoId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await (await app.request("/auth/api-keys/memos")).json()).memos).toHaveLength(0);
    expect(pool.getAll()).toHaveLength(1);
  });

  // ── Proxy routes ──────────────────────────────────────────────

  it("adds an API key with proxyId and allows updating proxyId via PATCH", async () => {
    const createRes = await app.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.5"],
        apiKey: "sk-test-proxy-key",
        proxyId: "proxy-custom-uuid",
      }),
    });
    expect(createRes.status).toBe(200);
    const createdBody = await createRes.json() as { keys: Array<{ id: string; proxyId?: string | null }> };
    expect(createdBody.keys[0].proxyId).toBe("proxy-custom-uuid");

    const keyId = createdBody.keys[0].id;

    // PATCH to "direct"
    const patchRes = await app.request(`/auth/api-keys/${keyId}/proxy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyId: "direct" }),
    });
    expect(patchRes.status).toBe(200);
    expect(pool.getEntry(keyId)?.proxyId).toBe("direct");

    // PATCH to null
    const clearRes = await app.request(`/auth/api-keys/${keyId}/proxy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyId: null }),
    });
    expect(clearRes.status).toBe(200);
    expect(pool.getEntry(keyId)?.proxyId).toBeNull();
  });

  it("validates proxyId against ProxyPool on POST and PATCH", async () => {
    const mockProxyPool = {
      getById: vi.fn((id: string) => (id === "known-proxy" ? { id: "known-proxy" } : undefined)),
    };
    const appWithProxy = createApiKeyRoutes(
      pool,
      new ApiKeyModelCache({ persistence: modelPersistence, fetchFn }),
      new ApiKeyMemoStore(createMemoryMemoPersistence()),
      mockProxyPool as never,
    );

    // Reject invalid proxyId on POST
    const badPost = await appWithProxy.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.5"],
        apiKey: "sk-test",
        proxyId: "unknown-proxy",
      }),
    });
    expect(badPost.status).toBe(400);

    // Accept known proxyId on POST
    const goodPost = await appWithProxy.request("/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        models: ["gpt-5.5"],
        apiKey: "sk-test",
        proxyId: "known-proxy",
      }),
    });
    expect(goodPost.status).toBe(200);
    const createdKey = pool.getAll().find((k) => k.apiKey === "sk-test")!;

    // Reject invalid proxyId on PATCH
    const badPatch = await appWithProxy.request(`/auth/api-keys/${createdKey.id}/proxy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyId: "bogus-proxy" }),
    });
    expect(badPatch.status).toBe(400);

    // Accept special keywords on PATCH
    for (const special of ["direct", "auto", "global", null]) {
      const goodPatch = await appWithProxy.request(`/auth/api-keys/${createdKey.id}/proxy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: special }),
      });
      expect(goodPatch.status).toBe(200);
    }
  });
});

