/**
 * incompleteReasonToAnthropicStopReason — pure mapping tests.
 *
 * The Codex Responses API reports truncation via
 * `response.incomplete_details.reason`; the Anthropic Messages API has its
 * own stop_reason enum. See src/translation/incomplete-stop-reason.ts.
 */
import { describe, it, expect } from "vitest";
import { incompleteReasonToAnthropicStopReason } from "../../../src/translation/incomplete-stop-reason.js";

describe("incompleteReasonToAnthropicStopReason", () => {
  it("maps max_output_tokens to max_tokens", () => {
    expect(incompleteReasonToAnthropicStopReason("max_output_tokens")).toBe("max_tokens");
  });

  it("maps content_filter to refusal", () => {
    expect(incompleteReasonToAnthropicStopReason("content_filter")).toBe("refusal");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(incompleteReasonToAnthropicStopReason("  Max_Output_Tokens ")).toBe("max_tokens");
    expect(incompleteReasonToAnthropicStopReason("CONTENT_FILTER")).toBe("refusal");
  });

  it("returns null for unknown reasons (callers keep tool_use/end_turn priority)", () => {
    expect(incompleteReasonToAnthropicStopReason("context_window_exceeded")).toBeNull();
    expect(incompleteReasonToAnthropicStopReason("")).toBeNull();
  });

  it("returns null for missing reasons", () => {
    expect(incompleteReasonToAnthropicStopReason(undefined)).toBeNull();
    expect(incompleteReasonToAnthropicStopReason(null)).toBeNull();
  });
});
