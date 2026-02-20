/**
 * Shared Codex SSE event data extraction layer.
 *
 * The three translation files (OpenAI, Anthropic, Gemini) all extract
 * the same data from Codex events — this module centralizes that logic.
 */

import type { CodexApi, CodexSSEEvent } from "../proxy/codex-api.js";
import {
  parseCodexEvent,
  type TypedCodexEvent,
} from "../types/codex-events.js";

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
}

export interface ExtractedEvent {
  typed: TypedCodexEvent;
  responseId?: string;
  textDelta?: string;
  usage?: UsageInfo;
}

/**
 * Iterate over a Codex SSE stream, parsing + extracting common fields.
 * Yields ExtractedEvent with pre-extracted responseId, textDelta, and usage.
 */
export async function* iterateCodexEvents(
  codexApi: CodexApi,
  rawResponse: Response,
): AsyncGenerator<ExtractedEvent> {
  for await (const raw of codexApi.parseStream(rawResponse)) {
    const typed = parseCodexEvent(raw);
    const extracted: ExtractedEvent = { typed };

    switch (typed.type) {
      case "response.created":
      case "response.in_progress":
        if (typed.response.id) extracted.responseId = typed.response.id;
        break;

      case "response.output_text.delta":
        extracted.textDelta = typed.delta;
        break;

      case "response.completed":
        if (typed.response.id) extracted.responseId = typed.response.id;
        if (typed.response.usage) extracted.usage = typed.response.usage;
        break;
    }

    yield extracted;
  }
}
