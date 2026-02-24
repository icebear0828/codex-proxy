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
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicUsage,
} from "../types/anthropic.js";
import { iterateCodexEvents } from "./codex-event-extractor.js";

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
  let hasToolCalls = false;
  let contentIndex = 0;
  let textBlockStarted = false;
  const callIdsWithDeltas = new Set<string>();

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
    index: contentIndex,
    content_block: { type: "text", text: "" },
  });
  textBlockStarted = true;

  // 3. Process Codex stream events
  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    // Handle function call start → close text block, open tool_use block
    if (evt.functionCallStart) {
      hasToolCalls = true;

      // Close text block if still open
      if (textBlockStarted) {
        yield formatSSE("content_block_stop", {
          type: "content_block_stop",
          index: contentIndex,
        });
        contentIndex++;
        textBlockStarted = false;
      }

      // Start tool_use block
      yield formatSSE("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: {
          type: "tool_use",
          id: evt.functionCallStart.callId,
          name: evt.functionCallStart.name,
          input: {},
        },
      });
      continue;
    }

    if (evt.functionCallDelta) {
      callIdsWithDeltas.add(evt.functionCallDelta.callId);
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "input_json_delta", partial_json: evt.functionCallDelta.delta },
      });
      continue;
    }

    if (evt.functionCallDone) {
      // Emit full arguments if no deltas were streamed
      if (!callIdsWithDeltas.has(evt.functionCallDone.callId)) {
        yield formatSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "input_json_delta", partial_json: evt.functionCallDone.arguments },
        });
      }
      // Close this tool_use block
      yield formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
      contentIndex++;
      continue;
    }

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          // Reopen a text block if the previous one was closed (e.g. after tool calls)
          if (!textBlockStarted) {
            yield formatSSE("content_block_start", {
              type: "content_block_start",
              index: contentIndex,
              content_block: { type: "text", text: "" },
            });
            textBlockStarted = true;
          }
          yield formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: evt.textDelta },
          });
        }
        break;
      }

      case "response.completed": {
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens;
          outputTokens = evt.usage.output_tokens;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens });
        }
        break;
      }
    }
  }

  // 4. Close text block if still open (no tool calls, or text came before tools)
  if (textBlockStarted) {
    yield formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: contentIndex,
    });
  }

  // 5. message_delta with stop_reason and usage
  yield formatSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn" },
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

  // Collect tool calls
  const toolUseBlocks: AnthropicContentBlock[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
    }
    if (evt.functionCallDone) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty object */ }
      toolUseBlocks.push({
        type: "tool_use",
        id: evt.functionCallDone.callId,
        name: evt.functionCallDone.name,
        input: parsedInput,
      });
    }
  }

  const hasToolCalls = toolUseBlocks.length > 0;
  const content: AnthropicContentBlock[] = [];
  if (fullText) {
    content.push({ type: "text", text: fullText });
  }
  content.push(...toolUseBlocks);
  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
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
      content,
      model,
      stop_reason: hasToolCalls ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    },
    usage,
    responseId,
  };
}
