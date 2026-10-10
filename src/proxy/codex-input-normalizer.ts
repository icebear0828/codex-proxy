import type { CodexInputItem } from "./codex-types.js";

/**
 * The Codex backend rejects `type: "message"` input items with `role: "system"`
 * ("System messages are not allowed"); it accepts `developer`.
 * Rewrites system → developer, leaving every other item (and field) as-is.
 * Returns the original array when nothing changed; never mutates inputs.
 */
export function normalizeCodexSystemRoles(input: CodexInputItem[]): CodexInputItem[] {
  let changed = false;
  const out = input.map((item): CodexInputItem => {
    if (typeof item === "object" && item !== null && "role" in item && item.role === "system") {
      changed = true;
      return { ...item, role: "developer" };
    }
    return item;
  });
  return changed ? out : input;
}
