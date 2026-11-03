import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_MODEL_PRESETS,
  DEFAULT_ANTHROPIC_MODELS,
} from "../../../web/src/components/AnthropicSetup";

describe("AnthropicSetup defaults", () => {
  it("maps current Claude families to the desired Codex defaults", () => {
    expect(DEFAULT_ANTHROPIC_MODELS).toEqual({
      opus: "gpt-6.1-sol",
      sonnet: "gpt-6.1-terra",
      haiku: "gpt-6-luna",
    });

    expect(ANTHROPIC_MODEL_PRESETS.slice(0, 3)).toEqual([
      { label: "gpt-6.1-sol (Opus)", value: "gpt-6.1-sol" },
      { label: "gpt-6.1-terra (Sonnet)", value: "gpt-6.1-terra" },
      { label: "gpt-6-luna (Haiku)", value: "gpt-6-luna" },
    ]);
  });
});
