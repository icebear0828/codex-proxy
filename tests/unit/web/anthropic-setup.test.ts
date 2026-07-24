import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_MODEL_PRESETS,
  DEFAULT_ANTHROPIC_MODELS,
} from "../../../web/src/components/AnthropicSetup";

describe("AnthropicSetup defaults", () => {
  it("maps current Claude families to the desired Codex defaults", () => {
    expect(DEFAULT_ANTHROPIC_MODELS).toEqual({
      opus: "gpt-5.6-sol",
      sonnet: "gpt-5.6-terra",
      haiku: "gpt-5.6-luna",
    });

    expect(ANTHROPIC_MODEL_PRESETS.slice(0, 3)).toEqual([
      { label: "gpt-5.6-sol (Opus)", value: "gpt-5.6-sol" },
      { label: "gpt-5.6-terra (Sonnet)", value: "gpt-5.6-terra" },
      { label: "gpt-5.6-luna (Haiku)", value: "gpt-5.6-luna" },
    ]);
  });
});
