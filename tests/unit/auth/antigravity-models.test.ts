import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_SUPPORTED_MODELS } from "@src/auth/antigravity-models.js";

describe("ANTIGRAVITY_SUPPORTED_MODELS", () => {
  it("includes gemini-2.5-pro with expected metadata", () => {
    const model = ANTIGRAVITY_SUPPORTED_MODELS.find((m) => m.id === "gemini-2.5-pro");
    expect(model).toEqual({
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      family: "gemini",
    });
  });

  it("does not have duplicate model IDs", () => {
    const ids = ANTIGRAVITY_SUPPORTED_MODELS.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});