/**
 * Translate Codex Responses API SSE stream → Anthropic Messages API format.
 *
 * Codex SSE events:
 *   response.created → extract response ID
 *   response.reasoning_summary_text.delta → thinking block (if wantThinking)
 *   response.output_text.delta → content_block_delta (text_delta)
 *   response.completed → content_block_stop + message_delta + message_stop
 *
 * Non-streaming: collect all text, return Anthropic message response.
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicUsage,
} from "../types/anthropic.js";
import { iterateCodexEvents, EmptyResponseError, type UsageInfo } from "./codex-event-extractor.js";

/** Format an Anthropic SSE event with named event type */
function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream Codex Responses API events as Anthropic Messages SSE.
 * Yields string chunks ready to write to the HTTP response.
 *
 * When wantThinking is true, reasoning summary deltas are emitted as
 * thinking content blocks before the text block.
 */
export async function* streamCodexToAnthropic(
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: UsageInfo) => void,
  onResponseId?: (id: string) => void,
  wantThinking?: boolean,
): AsyncGenerator<string> {
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let outputTokens = 0;
  let inputTokens = 0;
  let cachedTokens: number | undefined;
  let hasToolCalls = false;
  let hasContent = false;
  let contentIndex = 0;
  let textBlockStarted = false;
  let thinkingBlockStarted = false;
  const callIdsWithDeltas = new Set<string>();

  // Helper: close an open block and advance the index
  function* closeBlock(blockType: "thinking" | "text"): Generator<string> {
    yield formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: contentIndex,
    });
    contentIndex++;
    if (blockType === "thinking") thinkingBlockStarted = false;
    else textBlockStarted = false;
  }

  // Helper: ensure thinking block is closed before a non-thinking block
  function* closeThinkingIfOpen(): Generator<string> {
    if (thinkingBlockStarted) yield* closeBlock("thinking");
  }

  // Helper: ensure text block is closed
  function* closeTextIfOpen(): Generator<string> {
    if (textBlockStarted) yield* closeBlock("text");
  }

  // Helper: ensure a text block is open
  function* ensureTextBlock(): Generator<string> {
    if (!textBlockStarted) {
      yield formatSSE("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" },
      });
      textBlockStarted = true;
    }
  }

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

  // Don't eagerly open a text block — wait for actual content so thinking can come first

  // 2. Process Codex stream events
  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    // Handle upstream error events
    if (evt.error) {
      yield* closeThinkingIfOpen();
      yield* ensureTextBlock();
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "text_delta", text: `[Error] ${evt.error.code}: ${evt.error.message}` },
      });
      yield* closeBlock("text");
      yield formatSSE("error", {
        type: "error",
        error: { type: "api_error", message: `${evt.error.code}: ${evt.error.message}` },
      });
      yield formatSSE("message_stop", { type: "message_stop" });
      return;
    }

    // Handle reasoning delta → thinking block (only if client wants thinking)
    if (evt.reasoningDelta && wantThinking) {
      hasContent = true;
      yield* closeTextIfOpen();
      // Open thinking block if not already open
      if (!thinkingBlockStarted) {
        yield formatSSE("content_block_start", {
          type: "content_block_start",
          index: contentIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        thinkingBlockStarted = true;
      }
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "thinking_delta", thinking: evt.reasoningDelta },
      });
      continue;
    }

    // Handle function call start → close open blocks, open tool_use block
    if (evt.functionCallStart) {
      hasToolCalls = true;
      hasContent = true;

      yield* closeThinkingIfOpen();
      yield* closeTextIfOpen();

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
          hasContent = true;
          // Close thinking block if open (transition from thinking → text)
          yield* closeThinkingIfOpen();
          // Open a text block if not already open
          yield* ensureTextBlock();
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
          cachedTokens = evt.usage.cached_tokens;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, reasoning_tokens: evt.usage.reasoning_tokens });
        }
        // Inject error text if stream completed with no content
        if (!hasContent) {
          yield* ensureTextBlock();
          yield formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: "[Error] Codex returned an empty response. Please retry." },
          });
        }
        break;
      }
    }
  }

  // 3. Close any open blocks
  yield* closeThinkingIfOpen();
  yield* closeTextIfOpen();

  // 4. message_delta with stop_reason and usage
  yield formatSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn" },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokens != null ? { cache_read_input_tokens: cachedTokens } : {}),
    },
  });

  // 5. message_stop
  yield formatSSE("message_stop", {
    type: "message_stop",
  });
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * Anthropic Messages response.
 */
export async function collectCodexToAnthropicResponse(
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  wantThinking?: boolean,
): Promise<{
  response: AnthropicMessagesResponse;
  usage: UsageInfo;
  responseId: string | null;
}> {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let fullText = "";
  let fullReasoning = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let responseId: string | null = null;

  // Collect tool calls
  const toolUseBlocks: AnthropicContentBlock[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.error) {
      throw new Error(`Codex API error: ${evt.error.code}: ${evt.error.message}`);
    }
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.reasoningDelta) fullReasoning += evt.reasoningDelta;
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
      cachedTokens = evt.usage.cached_tokens;
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

  // Detect empty response (HTTP 200 but no content)
  if (!fullText && toolUseBlocks.length === 0 && outputTokens === 0) {
    throw new EmptyResponseError(responseId, { input_tokens: inputTokens, output_tokens: outputTokens });
  }

  const hasToolCalls = toolUseBlocks.length > 0;
  const content: AnthropicContentBlock[] = [];
  // Thinking block comes first if requested and available
  if (wantThinking && fullReasoning) {
    content.push({ type: "thinking", thinking: fullReasoning });
  }
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
    ...(cachedTokens != null ? { cache_read_input_tokens: cachedTokens } : {}),
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
