/**
 * Tests for ApiKeyPool — CRUD, persistence, import/export.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyPersistence, ApiKeyEntry } from "@src/auth/api-key-pool.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => { stored = [...keys]; },
  };
}

describe("ApiKeyPool", () => {
  let pool: ApiKeyPool;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
  });

  // ── Add / Get ──────────────────────────────────────────────────

  it("adds a key and returns entry with generated id", () => {
    const entry = pool.add({
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test-key-123456",
    });
    expect(entry.id).toBeTruthy();
    expect(entry.provider).toBe("anthropic");
    expect(entry.model).toBe("claude-opus-4-6");
    expect(entry.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(entry.status).toBe("active");
    expect(entry.label).toBeNull();
    expect(entry.lastUsedAt).toBeNull();
    expect(entry.capabilities).toEqual(["chat"]);
  });

  it("uses default baseUrl for builtin providers", () => {
    const a = pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });
    const o = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2" });
    const g = pool.add({ provider: "gemini", model: "gemini-3.1-pro-preview", apiKey: "k3" });

    expect(a.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(o.baseUrl).toBe("https://api.openai.com/v1");
    expect(g.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("uses custom baseUrl when provided", () => {
    const entry = pool.add({
      provider: "custom",
      model: "my-model",
      apiKey: "k1",
      baseUrl: "https://my-api.example.com/v1",
    });
    expect(entry.baseUrl).toBe("https://my-api.example.com/v1");
  });

  it("getEntry returns the added entry", () => {
    const added = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    const found = pool.getEntry(added.id);
    expect(found).toBeDefined();
    expect(found!.model).toBe("gpt-5.4");
  });

  it("getEntry returns undefined for missing id", () => {
    expect(pool.getEntry("nonexistent")).toBeUndefined();
  });

  it("getAll returns all entries", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k2" });
    expect(pool.getAll()).toHaveLength(2);
  });

  // ── Query by model / provider ─────────────────────────────────

  it("getByModel returns only active entries with matching model", () => {
    const e1 = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.add({ provider: "openai", model: "gpt-5.4-mini", apiKey: "k2" });
    const e3 = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k3" });
    pool.setStatus(e3.id, "disabled");

    const results = pool.getByModel("gpt-5.4");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(e1.id);
  });

  it("filters active entries by model and capability", () => {
    const chat = pool.add({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "chat-key",
      capabilities: ["chat"],
    });
    const embeddings = pool.add({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "embedding-key",
      capabilities: ["embeddings"],
    });
    const disabled = pool.add({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "disabled-key",
      capabilities: ["embeddings"],
    });
    pool.setStatus(disabled.id, "disabled");

    expect(pool.getByModelAndCapability("text-embedding-3-small", "chat").map((entry) => entry.id)).toEqual([chat.id]);
    expect(pool.getByModelAndCapability("text-embedding-3-small", "embeddings").map((entry) => entry.id)).toEqual([embeddings.id]);
  });

  it("loads legacy persisted entries without capabilities as chat-only", () => {
    const persistence = createMemoryPersistence();
    const pool1 = new ApiKeyPool(persistence);
    pool1.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const legacyEntry = pool1.getAll()[0];
    const legacyPersistence: ApiKeyPersistence = {
      load: () => [{
        id: legacyEntry.id,
        provider: legacyEntry.provider,
        model: legacyEntry.model,
        apiKey: legacyEntry.apiKey,
        baseUrl: legacyEntry.baseUrl,
        label: legacyEntry.label,
        status: legacyEntry.status,
        addedAt: legacyEntry.addedAt,
        lastUsedAt: legacyEntry.lastUsedAt,
      }],
      save: () => {},
    };

    const pool2 = new ApiKeyPool(legacyPersistence);
    expect(pool2.getAll()[0].capabilities).toEqual(["chat"]);
    expect(pool2.getByModelAndCapability("gpt-5.4", "chat")).toHaveLength(1);
    expect(pool2.getByModelAndCapability("gpt-5.4", "embeddings")).toHaveLength(0);
  });

  it("getByProvider returns active entries for that provider", () => {
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });
    pool.add({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k2" });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k3" });

    const results = pool.getByProvider("anthropic");
    expect(results).toHaveLength(2);
  });

  it("hasActiveModel returns true for active entry", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    expect(pool.hasActiveModel("gpt-5.4")).toBe(true);
  });

  it("hasActiveModel returns false for disabled entry", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.setStatus(entry.id, "disabled");
    expect(pool.hasActiveModel("gpt-5.4")).toBe(false);
  });

  // ── Remove ────────────────────────────────────────────────────

  it("remove deletes the entry", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    expect(pool.remove(entry.id)).toBe(true);
    expect(pool.getAll()).toHaveLength(0);
  });

  it("remove returns false for missing id", () => {
    expect(pool.remove("nonexistent")).toBe(false);
  });

  // ── Label ─────────────────────────────────────────────────────

  it("setLabel updates and returns true", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    expect(pool.setLabel(entry.id, "Production")).toBe(true);
    expect(pool.getEntry(entry.id)!.label).toBe("Production");
  });

  it("setLabel with null clears label", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1", label: "Dev" });
    pool.setLabel(entry.id, null);
    expect(pool.getEntry(entry.id)!.label).toBeNull();
  });

  // ── Status ────────────────────────────────────────────────────

  it("setStatus changes status", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.setStatus(entry.id, "disabled");
    expect(pool.getEntry(entry.id)!.status).toBe("disabled");
  });

  // ── markUsed ──────────────────────────────────────────────────

  it("markUsed updates lastUsedAt", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    expect(entry.lastUsedAt).toBeNull();
    pool.markUsed(entry.id);
    expect(pool.getEntry(entry.id)!.lastUsedAt).toBeTruthy();
  });

  // ── Import ────────────────────────────────────────────────────

  it("importMany adds multiple keys", () => {
    const result = pool.importMany([
      { provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" },
      { provider: "openai", model: "gpt-5.4", apiKey: "k2" },
      { provider: "gemini", model: "gemini-3.1-pro-preview", apiKey: "k3" },
    ]);
    expect(result.added).toBe(3);
    expect(result.failed).toBe(0);
    expect(pool.getAll()).toHaveLength(3);
  });

  // ── Export ────────────────────────────────────────────────────

  it("exportAll masks API keys by default", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "sk-1234567890abcdef" });
    const exported = pool.exportAll(false);
    expect(exported[0].apiKey).not.toBe("sk-1234567890abcdef");
    expect(exported[0].apiKey).toContain("****");
  });

  it("exportAll with unmask=true returns full keys", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "sk-1234567890abcdef" });
    const exported = pool.exportAll(true);
    expect(exported[0].apiKey).toBe("sk-1234567890abcdef");
  });

  it("exportForReimport returns all keys in importable format", () => {
    pool.add({
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "k1",
      label: "Prod",
      capabilities: ["chat", "embeddings"],
    });
    const exported = pool.exportForReimport();
    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "k1",
      baseUrl: "https://api.anthropic.com/v1",
      label: "Prod",
      capabilities: ["chat", "embeddings"],
      wire: "chat",
    });
  });

  // ── Persistence ───────────────────────────────────────────────

  it("persists entries across pool instances", () => {
    const persistence = createMemoryPersistence();
    const pool1 = new ApiKeyPool(persistence);
    pool1.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const pool2 = new ApiKeyPool(persistence);
    expect(pool2.getAll()).toHaveLength(1);
    expect(pool2.getAll()[0].model).toBe("gpt-5.4");
  });

  // ── Wire protocol ─────────────────────────────────────────────

  it("defaults wire to chat on add and preserves explicit responses", () => {
    expect(pool.add({ provider: "openai", model: "gpt-5.5", apiKey: "k" }).wire).toBe("chat");
    expect(pool.add({ provider: "custom", model: "m", apiKey: "k", baseUrl: "https://x.dev/v1", wire: "responses" }).wire).toBe("responses");
  });

  it("migrates legacy persisted entries without a wire field to chat", () => {
    // Simulate an api-keys.json written before the wire field existed.
    const legacy = {
      id: "legacy1",
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      label: null,
      capabilities: ["chat"],
      status: "active",
      addedAt: "2026-01-01T00:00:00Z",
      lastUsedAt: null,
    };
    const persistence: ApiKeyPersistence = {
      load: () => [legacy as unknown as ApiKeyEntry],
      save: () => { /* noop */ },
    };
    const pool2 = new ApiKeyPool(persistence);
    expect(pool2.getAll()[0].wire).toBe("chat");
  });
});
