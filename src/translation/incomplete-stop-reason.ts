/**
 * Map a Codex `response.incomplete` reason to the Anthropic stop_reason.
 *
 * The Codex Responses API reports truncation via
 * `response.incomplete_details.reason` (official values: "max_output_tokens",
 * "content_filter"). Anthropic's Messages API uses its own stop_reason enum —
 * passing the raw Codex reason through would produce an invalid value, while
 * ignoring the event entirely reports a truncated answer as a normal
 * "end_turn" and the client believes the model finished on its own.
 *
 * Returns null when the reason has no dedicated Anthropic equivalent (or is
 * missing) — callers then keep their existing tool_use/end_turn priority.
 */
export type IncompleteStopReason = "max_tokens" | "refusal";

export function incompleteReasonToAnthropicStopReason(
  reason: string | undefined | null,
): IncompleteStopReason | null {
  switch (typeof reason === "string" ? reason.trim().toLowerCase() : "") {
    case "max_output_tokens":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return null;
  }
}
