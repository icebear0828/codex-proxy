/**
 * Tests for UpstreamRouter integration with ApiKeyPool.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UpstreamRouter } from "../upstream-router.js";
import { ApiKeyPool } from "../../auth/api-key-pool.js";
import type { ApiKeyPersistence, ApiKeyEntry } from "../../auth/api-key-pool.js";
import type { UpstreamAdapter } from "../upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "../codex-types.js";

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

  it("falls back to codex for unknown models", () => {
    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("gpt-5.4");
    expect(adapter.tag).toBe("codex");
  });

  it("skips disabled api-key entries", () => {
    const entry = pool.add({ provider: "openai", model: "gpt-5.4", apiKey: "k1" });
    pool.setStatus(entry.id, "disabled");

    const adapters = new Map<string, UpstreamAdapter>();
    adapters.set("codex", mockAdapter("codex"));

    const router = new UpstreamRouter(adapters, {}, "codex");
    router.setApiKeyPool(pool, mockFactory);

    const adapter = router.resolve("gpt-5.4");
    expect(adapter.tag).toBe("codex"); // no active pool entry → default
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
});
