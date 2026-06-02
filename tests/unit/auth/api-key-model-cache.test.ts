import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyModelCache,
  MODEL_CACHE_TTL_MS,
  normalizeProviderModels,
  type ApiKeyModelCacheFile,
  type ApiKeyModelCachePersistence,
} from "@src/auth/api-key-model-cache.js";

function createMemoryPersistence(initial: ApiKeyModelCacheFile = { entries: {} }): ApiKeyModelCachePersistence & { snapshot(): ApiKeyModelCacheFile } {
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

describe("ApiKeyModelCache", () => {
  it("caches fetched models by URL and reuses them for a different API key", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-test", name: "GPT Test" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const first = await cache.fetchModels({ provider: "openai", apiKey: "sk-one" });
    const second = await cache.fetchModels({ provider: "openai", apiKey: "sk-two" });

    expect(first).toEqual([{ id: "gpt-test", displayName: "GPT Test" }]);
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persistence.snapshot())).not.toContain("sk-one");
  });

  it("expires cache entries after seven days", async () => {
    const fetchedAt = new Date(new Date("2026-01-01T00:00:00Z").getTime() - MODEL_CACHE_TTL_MS - 1).toISOString();
    const persistence = createMemoryPersistence({
      entries: {
        "https://api.openai.com/v1/models": {
          url: "https://api.openai.com/v1/models",
          fetchedAt,
          models: [{ id: "stale", displayName: "Stale" }],
        },
      },
    });
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "fresh" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await expect(cache.fetchModels({ provider: "openai", apiKey: "sk" })).resolves.toEqual([{ id: "fresh", displayName: "fresh" }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("includes original error message for network failures", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED 127.0.0.1:443"); });
    const cache = new ApiKeyModelCache({ persistence: createMemoryPersistence(), fetchFn });

    await expect(cache.fetchModels({ provider: "openai", apiKey: "sk" }))
      .rejects.toMatchObject({ kind: "network", message: expect.stringContaining("ECONNREFUSED") });
  });

  it("uses a Gemini request key without storing it in the cache URL", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] }));
    const cache = new ApiKeyModelCache({ persistence, fetchFn });

    await cache.fetchModels({ provider: "gemini", apiKey: "gem-key" });

    const requestedUrl = String(fetchFn.mock.calls[0][0]);
    expect(requestedUrl).toContain("key=gem-key");
    expect(Object.keys(persistence.snapshot().entries)).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
    expect(JSON.stringify(persistence.snapshot())).not.toContain("gem-key");
  });

  it("builds custom provider cache keys from normalized model URLs", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "custom-model" }] }));
    const cache = new ApiKeyModelCache({ persistence, fetchFn });

    await cache.fetchModels({ provider: "custom", apiKey: "custom-key", baseUrl: "https://example.com/v1/" });
    await cache.fetchModels({ provider: "custom", apiKey: "another-key", baseUrl: "https://example.com/v1" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Object.keys(persistence.snapshot().entries)).toEqual(["https://example.com/v1/models"]);
  });

  it("returns cached models in the built-in catalog", () => {
    const persistence = createMemoryPersistence({
      entries: {
        "https://api.anthropic.com/v1/models": {
          url: "https://api.anthropic.com/v1/models",
          fetchedAt: "2026-01-01T00:00:00Z",
          models: [{ id: "claude-test", displayName: "Claude Test" }],
        },
      },
    });
    const cache = new ApiKeyModelCache({
      persistence,
      now: () => new Date("2026-01-02T00:00:00Z"),
    });

    const catalog = cache.getCatalogWithCachedModels();

    // Cached models override the static fallback for anthropic.
    expect(catalog.anthropic.models).toEqual([{ id: "claude-test", displayName: "Claude Test" }]);
    // openai has no cached entry — falls back to static defaults (non-empty).
    expect(catalog.openai.models.length).toBeGreaterThan(0);
    expect(catalog.openai.models[0]).toHaveProperty("id");
  });

  it("normalizes provider model payloads", () => {
    expect(normalizeProviderModels("openai", { data: [{ id: "gpt", name: "GPT" }, { id: "gpt", name: "Duplicate" }] })).toEqual([
      { id: "gpt", displayName: "Duplicate" },
    ]);
    expect(normalizeProviderModels("anthropic", { data: [{ id: "claude", display_name: "Claude" }] })).toEqual([
      { id: "claude", displayName: "Claude" },
    ]);
    expect(normalizeProviderModels("gemini", { models: [{ name: "models/gemini", displayName: "Gemini" }] })).toEqual([
      { id: "gemini", displayName: "Gemini" },
    ]);
    expect(normalizeProviderModels("custom", { data: [{ id: "custom", display_name: "Custom" }] })).toEqual([
      { id: "custom", displayName: "Custom" },
    ]);
  });
});
