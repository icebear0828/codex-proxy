/**
 * Translate Codex Responses API SSE stream → Anthropic Messages API format.
 *
 * Codex SSE events:
 *   response.created → extract response ID
 *   response.output_text.delta → content_block_delta (text_delta)
 *   response.completed → content_block_stop + message_delta + message_stop
 *
 * Non-streaming: collect all text, return Anthropic message response.
 */

import { randomUUID } from "crypto";
import type { CodexApi } from "../proxy/codex-api.js";
import type {
  AnthropicMessagesResponse,
  AnthropicUsage,
} from "../types/anthropic.js";

export interface AnthropicUsageInfo {
  input_tokens: number;
  output_tokens: number;
}

/** Format an Anthropic SSE event with named event type */
function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream Codex Responses API events as Anthropic Messages SSE.
 * Yields string chunks ready to write to the HTTP response.
 */
export async function* streamCodexToAnthropic(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: AnthropicUsageInfo) => void,
  onResponseId?: (id: string) => void,
): AsyncGenerator<string> {
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let outputTokens = 0;
  let inputTokens = 0;

  // 1. message_start
  yield formatSSE("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // 2. content_block_start for text block at index 0
  yield formatSSE("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  // 3. Process Codex stream events
  for await (const evt of codexApi.parseStream(rawResponse)) {
    const data = evt.data as Record<string, unknown>;

    switch (evt.event) {
      case "response.created":
      case "response.in_progress": {
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.id) {
          onResponseId?.(resp.id as string);
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = (data.delta as string) ?? "";
        if (delta) {
          yield formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta },
          });
        }
        break;
      }

      case "response.completed": {
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.usage) {
          const u = resp.usage as Record<string, number>;
          inputTokens = u.input_tokens ?? 0;
          outputTokens = u.output_tokens ?? 0;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens });
        }
        break;
      }
    }
  }

  // 4. content_block_stop
  yield formatSSE("content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });

  // 5. message_delta with stop_reason and usage
  yield formatSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: outputTokens },
  });

  // 6. message_stop
  yield formatSSE("message_stop", {
    type: "message_stop",
  });
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * Anthropic Messages response.
 */
export async function collectCodexToAnthropicResponse(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
): Promise<{
  response: AnthropicMessagesResponse;
  usage: AnthropicUsageInfo;
  responseId: string | null;
}> {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | null = null;

  for await (const evt of codexApi.parseStream(rawResponse)) {
    const data = evt.data as Record<string, unknown>;

    switch (evt.event) {
      case "response.created":
      case "response.in_progress": {
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.id) responseId = resp.id as string;
        break;
      }

      case "response.output_text.delta": {
        fullText += (data.delta as string) ?? "";
        break;
      }

      case "response.completed": {
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.id) responseId = resp.id as string;
        if (resp?.usage) {
          const u = resp.usage as Record<string, number>;
          inputTokens = u.input_tokens ?? 0;
          outputTokens = u.output_tokens ?? 0;
        }
        break;
      }
    }
  }

  const usage: AnthropicUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  return {
    response: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: fullText }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
    usage,
    responseId,
  };
}
