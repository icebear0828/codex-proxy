import { describe, expect, it } from "vitest";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "@src/proxy/codex-types.js";
import { createRuntimeUpstreamRouter } from "@src/proxy/upstream-router-bootstrap.js";

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => {
      stored = [...keys];
    },
  };
}

function mockAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: (_req: CodexResponsesRequest) => Promise.resolve(new Response()),
    async *parseStream(): AsyncGenerator<CodexSSEEvent> { /* no events */ },
  };
}

describe("createRuntimeUpstreamRouter", () => {
  it("creates a router even when startup has no configured adapters or persisted API keys", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const router = createRuntimeUpstreamRouter(new Map(), {}, pool, (entry) => mockAdapter(`dynamic-${entry.model}`));

    expect(router.resolveMatch("late-runtime-model").kind).toBe("not-found");

    pool.add({
      provider: "custom",
      model: "late-runtime-model",
      apiKey: "secret",
      baseUrl: "https://example.com/v1",
    });

    const match = router.resolveMatch("late-runtime-model");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.adapter.tag).toBe("dynamic-late-runtime-model");
    }
  });
});
