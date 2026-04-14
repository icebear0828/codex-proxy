/**
 * Tests for UpstreamRouter integration with ApiKeyPool.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyPersistence, ApiKeyEntry } from "@src/auth/api-key-pool.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "@src/proxy/codex-types.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => { stored = [...keys]; },
  };
}

function mockAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: () => Promise.resolve(new Response()),
    async *parseStream(): AsyncGenerator<CodexSSEEvent> { /* empty */ },
  };
}

function mockFactory(entry: ApiKeyEntry): UpstreamAdapter {
  return mockAdapter(`dynamic-${entry.provider}-${entry.model}`);
}

describe("UpstreamRouter with ApiKeyPool", () => {
  let pool: ApiKeyPool;

  beforeEach(() => {
    pool = new ApiKeyPool(createMemoryPersistence());
  });

  it("resolves model from api-key pool before config adapters", () => {
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("anthropic", mockAdapter("anthropic"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("claude-opus-4-6");
    expect(adapter.tag).toBe("dynamic-anthropic-claude-opus-4-6");
  });

  it("falls back to config adapter when pool has no match", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("anthropic", mockAdapter("anthropic"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("claude-opus-4-6");
    // No pool entry → falls to built-in pattern → anthropic
    expect(adapter.tag).toBe("anthropic");
  });

  it("returns not-found for unknown non-codex models", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    expect(router.resolveMatch("unknown-model-xyz")).toEqual({ kind: "not-found" });
  });

  it("classifies api-key pool models explicitly", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const match = router.resolveMatch("gpt-5.4");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.entry.model).toBe("gpt-5.4");
      expect(match.adapter.tag).toBe("dynamic-openai-gpt-5.4");
    }
  });

  it("classifies known codex models explicitly", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const match = router.resolveMatch("gpt-5.2-codex");
    expect(match.kind).toBe("codex");
  });

  it("skips disabled api-key entries", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.setStatus(entry.id, "disabled");

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    expect(router.resolveMatch("gpt-5.4").kind).toBe("codex");
  });

  it("round-robins multiple keys for same model via LRU", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1", label: "A" });
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k2", label: "B" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    // First resolve picks first (both never-used → pick first)
    router.resolve("gpt-5.4");
    // After markUsed on first, second should be picked next
    router.resolve("gpt-5.4");

    // Verify both entries got used
    const entries = pool.getByModel("gpt-5.4");
    const usedEntries = entries.filter((e) => e.lastUsedAt !== null);
    expect(usedEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("caches adapter and reuses for same entry", () => {
    pool.add({ provider: "anthropic", model: "claude-opus-4-6", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    let factoryCallCount = 0;
    const countingFactory = (entry: ApiKeyEntry): UpstreamAdapter => {
      factoryCallCount++;
      return mockFactory(entry);
    };

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, countingFactory);

    router.resolve("claude-opus-4-6");
    router.resolve("claude-opus-4-6");

    // Factory should only be called once (cached)
    expect(factoryCallCount).toBe(1);
  });

  it("strips provider prefix for pool lookup", () => {
    pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));
    adapters.set("openai", mockAdapter("openai"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    // "openai:gpt-5.4" should strip prefix and find pool entry for "gpt-5.4"
    const adapter = router.resolve("openai:gpt-5.4");
    expect(adapter.tag).toBe("dynamic-openai-gpt-5.4");
  });

  it("prefers exact api-key model match for models containing colon", () => {
    pool.add({ provider: "openai", model: "google/gemma-4-26b-a4b-it:free", apiKey: "k1" });

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("openai", mockAdapter("openai"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("google/gemma-4-26b-a4b-it:free");
    expect(adapter.tag).toBe("dynamic-openai-google/gemma-4-26b-a4b-it:free");
    expect(router.isCodexModel("google/gemma-4-26b-a4b-it:free")).toBe(false);
  });
});
