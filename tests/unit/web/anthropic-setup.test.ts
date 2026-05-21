import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_MODEL_PRESETS,
  DEFAULT_ANTHROPIC_MODELS,
} from "../../../web/src/components/AnthropicSetup";

describe("AnthropicSetup defaults", () => {
  it("maps current Claude families to the desired Codex defaults", () => {
    expect(DEFAULT_ANTHROPIC_MODELS).toEqual({
      opus: "gpt-5.5",
      sonnet: "gpt-5.4",
      haiku: "gpt-5.4-mini",
    });

    expect(ANTHROPIC_MODEL_PRESETS.slice(0, 2)).toEqual([
      { label: "gpt-5.5 (Opus 4.7)", value: "gpt-5.5" },
      { label: "gpt-5.4 (Sonnet 4.6)", value: "gpt-5.4" },
    ]);
  });
});
