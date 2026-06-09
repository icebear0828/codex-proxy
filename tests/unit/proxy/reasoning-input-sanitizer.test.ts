import { describe, expect, it } from "vitest";
import { sanitizeCodexInputItems } from "@src/proxy/reasoning-input-sanitizer.js";

describe("sanitizeCodexInputItems", () => {
  it("preserves valid reasoning items and removes unsupported signature fields", () => {
    const input = [{
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      encrypted_content: "enc_valid",
      summary: [{ type: "summary_text", text: "brief" }],
      content: [{ type: "reasoning_text", text: "hidden" }],
      signature: "anthropic-style-signature",
      extra: "drop-me",
    }];

    expect(sanitizeCodexInputItems(input)).toEqual([{
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      encrypted_content: "enc_valid",
      summary: [{ type: "summary_text", text: "brief" }],
      content: [{ type: "reasoning_text", text: "hidden" }],
    }]);
  });

  it("preserves reasoning items with an empty summary array", () => {
    const input = [{
      type: "reasoning",
      id: "rs_empty_summary",
      summary: [],
      encrypted_content: "enc_valid",
    }];

    expect(sanitizeCodexInputItems(input)).toEqual([{
      type: "reasoning",
      id: "rs_empty_summary",
      summary: [],
      encrypted_content: "enc_valid",
    }]);
  });

  it("drops invalid encrypted_content values instead of forwarding them", () => {
    const input = [
      { type: "reasoning", id: "rs_empty", summary: [], encrypted_content: "" },
      { type: "reasoning", id: "rs_number", summary: [], encrypted_content: 123 },
      { type: "reasoning", id: "rs_spaces", summary: [], encrypted_content: "   " },
    ];

    expect(sanitizeCodexInputItems(input)).toEqual([
      { type: "reasoning", id: "rs_empty", summary: [] },
      { type: "reasoning", id: "rs_number", summary: [] },
      { type: "reasoning", id: "rs_spaces", summary: [] },
    ]);
  });

  it("filters malformed reasoning summary and content parts", () => {
    const input = [{
      type: "reasoning",
      id: "rs_filtered",
      summary: [
        { type: "summary_text", text: "keep" },
        { type: "summary_text", text: 42 },
        { type: "text", text: "drop" },
      ],
      content: [
        { type: "reasoning_text", text: "keep reasoning" },
        { type: "reasoning_text" },
        { type: "output_text", text: "drop" },
      ],
    }];

    expect(sanitizeCodexInputItems(input)).toEqual([{
      type: "reasoning",
      id: "rs_filtered",
      summary: [{ type: "summary_text", text: "keep" }],
      content: [{ type: "reasoning_text", text: "keep reasoning" }],
    }]);
  });

  it("drops malformed reasoning items that are missing required identity fields", () => {
    const input = [
      { type: "reasoning", summary: [], encrypted_content: "enc_missing_id" },
      { type: "reasoning", id: "rs_missing_summary", encrypted_content: "enc_missing_summary" },
      { type: "reasoning", id: "", summary: [], encrypted_content: "enc_empty_id" },
    ];

    expect(sanitizeCodexInputItems(input)).toEqual([]);
  });

  it("drops compaction items with invalid encrypted_content", () => {
    const input = [
      { type: "compaction", id: "cmp_1", encrypted_content: "enc_compact", created_by: "codex" },
      { type: "compaction", encrypted_content: "" },
      { type: "compaction", encrypted_content: 7 },
    ];

    expect(sanitizeCodexInputItems(input)).toEqual([
      { type: "compaction", id: "cmp_1", encrypted_content: "enc_compact" },
    ]);
  });

  it("keeps non-reasoning input items unchanged in mixed arrays", () => {
    const user = { role: "user", content: "Hello" };
    const callOutput = { type: "function_call_output", call_id: "call_1", output: "ok" };

    expect(sanitizeCodexInputItems([
      user,
      { type: "reasoning", encrypted_content: "" },
      callOutput,
    ])).toEqual([
      user,
      callOutput,
    ]);
  });
});
