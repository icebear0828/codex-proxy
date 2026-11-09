import { describe, expect, it } from "vitest";
import { anthropicDisableParallelToolUse } from "@src/translation/tool-format.js";

describe("anthropicDisableParallelToolUse", () => {
  it("returns the Anthropic disable flag when present", () => {
    expect(anthropicDisableParallelToolUse({ type: "auto", disable_parallel_tool_use: true })).toBe(true);
    expect(anthropicDisableParallelToolUse({ type: "any", disable_parallel_tool_use: false })).toBe(false);
  });

  it("does not infer a parallel limit when the flag is absent", () => {
    expect(anthropicDisableParallelToolUse({ type: "tool", name: "search" })).toBeUndefined();
  });
});
