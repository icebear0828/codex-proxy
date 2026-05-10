import { createHash } from "crypto";

/** Short fingerprint of a request's "shape" — instructions + tools — used to
 *  isolate concurrent variants within the same client conversation.
 *
 *  Why: Claude Code (and other Anthropic clients) issue sub-agent / parallel
 *  tool calls under the same `x-claude-code-session-id`. They share a
 *  conversation id but use different system prompts and tool sets, so they
 *  belong on independent WS pool slots and prev_response_id chains — otherwise
 *  the main-thread WS keeps stealing the slot, sub-agents get bypassed onto
 *  fresh WS connections, and every sub-agent turn becomes a cold start.
 *
 *  The hash is deterministic over byte-stable inputs (same instructions + same
 *  tools array → same hash). 12 hex chars = 48 bits, ample to avoid collisions
 *  within a single conversation. */
export function computeVariantHash(
  instructions: string | null | undefined,
  tools: ReadonlyArray<unknown> | null | undefined,
): string {
  const instr = instructions ?? "";
  const toolsJson = tools && tools.length > 0 ? JSON.stringify(tools) : "[]";
  return createHash("sha256")
    .update(instr)
    .update("\x00")
    .update(toolsJson)
    .digest("hex")
    .slice(0, 12);
}
