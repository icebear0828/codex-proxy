/**
 * Tests for third-party API key management routes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
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

describe("api key routes", () => {
  let pool: ApiKeyPool;
  let app: ReturnType<typeof createApiKeyRoutes>;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
    app = createApiKeyRoutes(pool);
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
