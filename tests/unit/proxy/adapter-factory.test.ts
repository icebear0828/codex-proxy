import { describe, expect, it } from "vitest";
import { createAdapterForEntry } from "@src/proxy/adapter-factory.js";
import { OpenAIUpstream } from "@src/proxy/openai-upstream.js";
import { ResponsesUpstream } from "@src/proxy/responses-upstream.js";
import { AnthropicUpstream } from "@src/proxy/anthropic-upstream.js";
import { GeminiUpstream } from "@src/proxy/gemini-upstream.js";
import type { ApiKeyEntry, ApiKeyProvider, ApiKeyWire } from "@src/auth/api-key-pool.js";

function entry(
  provider: ApiKeyProvider,
  wire: ApiKeyWire = "chat",
  baseUrl = "https://api.example.com/v1",
): ApiKeyEntry {
  return {
    id: "id1",
    provider,
    model: "m",
    apiKey: "k",
    baseUrl,
    label: null,
    capabilities: ["chat"],
    wire,
    status: "active",
    addedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
  };
}

describe("createAdapterForEntry — wire routing", () => {
  it("OpenAI-family default to Chat Completions (OpenAIUpstream)", () => {
    for (const p of ["openai", "openrouter", "custom"] as const) {
      expect(createAdapterForEntry(entry(p, "chat"))).toBeInstanceOf(OpenAIUpstream);
    }
  });

  it("OpenAI-family with wire=responses use ResponsesUpstream", () => {
    for (const p of ["openai", "openrouter", "custom"] as const) {
      const adapter = createAdapterForEntry(entry(p, "responses"));
      expect(adapter).toBeInstanceOf(ResponsesUpstream);
      expect(adapter.tag).toBe(p);
    }
  });

  it("anthropic/gemini ignore wire and use their native adapters", () => {
    expect(createAdapterForEntry(entry("anthropic", "responses"))).toBeInstanceOf(AnthropicUpstream);
    expect(createAdapterForEntry(entry("gemini", "responses"))).toBeInstanceOf(GeminiUpstream);
  });
});
