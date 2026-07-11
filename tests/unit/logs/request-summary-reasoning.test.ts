import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ logs: { capture_body: false } })),
}));

import { summarizeRequestForLog } from "@src/logs/request-summary.js";

describe("request summary reasoning fields", () => {
  it("summarizes Anthropic effort sources", () => {
    const summary = summarizeRequestForLog("messages", {
      model: "gpt-5.6-sol",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Think deeply" }],
      thinking: { type: "adaptive", budget_tokens: 32000 },
      output_config: { effort: "ultra" },
    });

    expect(summary).toMatchObject({
      body_type: "anthropic.messages",
      thinking: "adaptive",
      thinking_budget_tokens: 32000,
      output_config_effort: "ultra",
    });
  });
});
