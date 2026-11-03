/**
 * Tests for API key catalog — predefined model lists.
 */

import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG, isBuiltinProvider } from "@src/auth/api-key-catalog.js";

describe("api-key-catalog", () => {
  it("has all four builtin providers", () => {
    expect(PROVIDER_CATALOG.anthropic).toBeDefined();
    expect(PROVIDER_CATALOG.openai).toBeDefined();
    expect(PROVIDER_CATALOG.gemini).toBeDefined();
    expect(PROVIDER_CATALOG.openrouter).toBeDefined();
  });

  it("has minimal static fallback models for all builtin providers", () => {
    for (const [, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(meta.models.length).toBeGreaterThan(0);
      for (const model of meta.models) {
        expect(model.id).toBeTruthy();
        expect(model.displayName).toBeTruthy();
      }
    }
  });

  it("each provider has a default base URL", () => {
    expect(PROVIDER_CATALOG.anthropic.defaultBaseUrl).toContain("anthropic.com");
    expect(PROVIDER_CATALOG.openai.defaultBaseUrl).toContain("openai.com");
    expect(PROVIDER_CATALOG.gemini.defaultBaseUrl).toContain("googleapis.com");
    expect(PROVIDER_CATALOG.openrouter.defaultBaseUrl).toContain("openrouter.ai");
  });

  it("isBuiltinProvider returns true for builtin providers", () => {
    expect(isBuiltinProvider("anthropic")).toBe(true);
    expect(isBuiltinProvider("openai")).toBe(true);
    expect(isBuiltinProvider("gemini")).toBe(true);
    expect(isBuiltinProvider("openrouter")).toBe(true);
  });

  it("isBuiltinProvider returns false for custom", () => {
    expect(isBuiltinProvider("custom")).toBe(false);
    expect(isBuiltinProvider("groq")).toBe(false);
  });

  it("uses current OpenAI fallback models", () => {
    expect(PROVIDER_CATALOG.openai.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("uses current OpenRouter fallback models", () => {
    expect(PROVIDER_CATALOG.openrouter.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1",
    ]);
  });
});
