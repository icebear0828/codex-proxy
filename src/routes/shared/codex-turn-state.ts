import type { Context } from "hono";

const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

/**
 * Relay the opaque upstream turn-state only on the native Codex Responses
 * route. Translated Chat/Messages/Gemini responses must not leak this
 * chatgpt.com-scoped header to clients that did not speak the Codex wire.
 */
export function relayCodexTurnState(
  c: Context,
  response: Response,
  formatTag: string,
): void {
  if (formatTag !== "Responses") return;
  const state = response.headers.get(CODEX_TURN_STATE_HEADER)?.trim();
  if (state) c.header(CODEX_TURN_STATE_HEADER, state);
}
