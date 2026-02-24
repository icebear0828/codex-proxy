/**
 * Translate Codex Responses API SSE stream → OpenAI Chat Completions format.
 *
 * Codex SSE events:
 *   response.created → (initial setup)
 *   response.output_text.delta → chat.completion.chunk (streaming text)
 *   response.output_text.done → (text complete)
 *   response.completed → [DONE]
 *
 * Non-streaming: collect all text, return chat.completion response.
 */

import { randomUUID } from "crypto";
import type { CodexApi } from "../proxy/codex-api.js";
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionToolCall,
  ChatCompletionChunkToolCall,
} from "../types/openai.js";
import { iterateCodexEvents, type UsageInfo } from "./codex-event-extractor.js";

export type { UsageInfo };

/** Format an SSE chunk for streaming output */
function formatSSE(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Stream Codex Responses API events as OpenAI chat.completion.chunk SSE.
 * Yields string chunks ready to write to the HTTP response.
 * Calls onUsage when the response.completed event arrives with usage data.
 */
export async function* streamCodexToOpenAI(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: UsageInfo) => void,
  onResponseId?: (id: string) => void,
): AsyncGenerator<string> {
  const chunkId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let hasToolCalls = false;
  // Track tool call indices by call_id
  const toolCallIndexMap = new Map<string, number>();
  let nextToolCallIndex = 0;
  // Track which call_ids have received argument deltas
  const callIdsWithDeltas = new Set<string>();

  // Send initial role chunk
  yield formatSSE({
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  });

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    // Handle function call events
    if (evt.functionCallStart) {
      hasToolCalls = true;
      const idx = nextToolCallIndex++;
      toolCallIndexMap.set(evt.functionCallStart.callId, idx);
      const toolCall: ChatCompletionChunkToolCall = {
        index: idx,
        id: evt.functionCallStart.callId,
        type: "function",
        function: {
          name: evt.functionCallStart.name,
          arguments: "",
        },
      };
      yield formatSSE({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [toolCall] },
            finish_reason: null,
          },
        ],
      });
      continue;
    }

    if (evt.functionCallDelta) {
      callIdsWithDeltas.add(evt.functionCallDelta.callId);
      const idx = toolCallIndexMap.get(evt.functionCallDelta.callId) ?? 0;
      const toolCall: ChatCompletionChunkToolCall = {
        index: idx,
        function: {
          arguments: evt.functionCallDelta.delta,
        },
      };
      yield formatSSE({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [toolCall] },
            finish_reason: null,
          },
        ],
      });
      continue;
    }

    // functionCallDone — emit full arguments if no deltas were streamed
    if (evt.functionCallDone) {
      if (!callIdsWithDeltas.has(evt.functionCallDone.callId)) {
        const idx = toolCallIndexMap.get(evt.functionCallDone.callId) ?? 0;
        const toolCall: ChatCompletionChunkToolCall = {
          index: idx,
          function: {
            arguments: evt.functionCallDone.arguments,
          },
        };
        yield formatSSE({
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [toolCall] },
              finish_reason: null,
            },
          ],
        });
      }
      continue;
    }

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          yield formatSSE({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: evt.textDelta },
                finish_reason: null,
              },
            ],
          });
        }
        break;
      }

      case "response.completed": {
        if (evt.usage) onUsage?.(evt.usage);
        yield formatSSE({
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
            },
          ],
        });
        break;
      }
    }
  }

  // Send [DONE] marker
  yield "data: [DONE]\n\n";
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * ChatCompletionResponse. Returns both the response and extracted usage.
 */
export async function collectCodexResponse(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
): Promise<{ response: ChatCompletionResponse; usage: UsageInfo; responseId: string | null }> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let responseId: string | null = null;

  // Collect tool calls
  const toolCalls: ChatCompletionToolCall[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.usage) {
      promptTokens = evt.usage.input_tokens;
      completionTokens = evt.usage.output_tokens;
    }
    if (evt.functionCallDone) {
      toolCalls.push({
        id: evt.functionCallDone.callId,
        type: "function",
        function: {
          name: evt.functionCallDone.name,
          arguments: evt.functionCallDone.arguments,
        },
      });
    }
  }

  const hasToolCalls = toolCalls.length > 0;
  const message: ChatCompletionResponse["choices"][0]["message"] = {
    role: "assistant",
    content: fullText || null,
  };
  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }

  return {
    response: {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: hasToolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
    },
    responseId,
  };
}
