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
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionToolCall,
  ChatCompletionChunkToolCall,
} from "../types/openai.js";
import { iterateCodexEvents, EmptyResponseError, type UsageInfo } from "./codex-event-extractor.js";
import { reconvertTupleValues } from "./tuple-schema.js";

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
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: UsageInfo) => void,
  onResponseId?: (id: string) => void,
  wantReasoning?: boolean,
  tupleSchema?: Record<string, unknown> | null,
): AsyncGenerator<string> {
  const chunkId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let hasToolCalls = false;
  let hasContent = false;
  // When tupleSchema is set, buffer text deltas to reconvert at response.completed
  let tupleTextBuffer = tupleSchema ? "" : null;
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

    // Handle upstream error events
    if (evt.error) {
      yield formatSSE({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: `[Error] ${evt.error.code}: ${evt.error.message}` },
            finish_reason: null,
          },
        ],
      });
      yield formatSSE({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      });
      yield "data: [DONE]\n\n";
      return;
    }

    // Handle function call events
    if (evt.functionCallStart) {
      hasToolCalls = true;
      hasContent = true;
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

    // Emit reasoning delta if client requested it
    if (evt.reasoningDelta && wantReasoning) {
      hasContent = true;
      yield formatSSE({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: evt.reasoningDelta },
            finish_reason: null,
          },
        ],
      });
    }

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          hasContent = true;
          if (tupleTextBuffer !== null) {
            // Buffer text for reconversion
            tupleTextBuffer += evt.textDelta;
          } else {
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
        }
        break;
      }

      case "response.completed": {
        // Flush buffered tuple text as reconverted JSON
        if (tupleTextBuffer !== null && tupleSchema && tupleTextBuffer) {
          try {
            const parsed = JSON.parse(tupleTextBuffer) as unknown;
            const reconverted = reconvertTupleValues(parsed, tupleSchema);
            yield formatSSE({
              id: chunkId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: JSON.stringify(reconverted) },
                  finish_reason: null,
                },
              ],
            });
          } catch (e) {
            console.warn("[tuple-reconvert] streaming JSON parse failed, emitting raw text:", e);
            yield formatSSE({
              id: chunkId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: tupleTextBuffer },
                  finish_reason: null,
                },
              ],
            });
          }
        }

        if (evt.usage) onUsage?.(evt.usage);
        // Inject error text if stream completed with no content
        if (!hasContent) {
          yield formatSSE({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: "[Error] Codex returned an empty response. Please retry." },
                finish_reason: null,
              },
            ],
          });
        }
        // Build usage object for final chunk (OpenAI includes usage in last streaming chunk)
        const chunkUsage: ChatCompletionChunk["usage"] = evt.usage
          ? {
              prompt_tokens: evt.usage.input_tokens,
              completion_tokens: evt.usage.output_tokens,
              total_tokens: evt.usage.input_tokens + evt.usage.output_tokens,
              ...(evt.usage.cached_tokens != null
                ? { prompt_tokens_details: { cached_tokens: evt.usage.cached_tokens } }
                : {}),
              ...(evt.usage.reasoning_tokens != null
                ? { completion_tokens_details: { reasoning_tokens: evt.usage.reasoning_tokens } }
                : {}),
            }
          : null;
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
          usage: chunkUsage,
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
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  wantReasoning?: boolean,
  tupleSchema?: Record<string, unknown> | null,
): Promise<{ response: ChatCompletionResponse; usage: UsageInfo; responseId: string | null }> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let fullText = "";
  let fullReasoning = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let responseId: string | null = null;

  // Collect tool calls
  const toolCalls: ChatCompletionToolCall[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.error) {
      throw new Error(`Codex API error: ${evt.error.code}: ${evt.error.message}`);
    }
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.reasoningDelta) fullReasoning += evt.reasoningDelta;
    if (evt.usage) {
      promptTokens = evt.usage.input_tokens;
      completionTokens = evt.usage.output_tokens;
      cachedTokens = evt.usage.cached_tokens;
      reasoningTokens = evt.usage.reasoning_tokens;
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

  // Detect empty response (HTTP 200 but no content)
  if (!fullText && toolCalls.length === 0 && completionTokens === 0) {
    throw new EmptyResponseError(responseId, { input_tokens: promptTokens, output_tokens: completionTokens });
  }

  // Reconvert tuple objects back to arrays in structured output
  if (tupleSchema && fullText) {
    try {
      const parsed = JSON.parse(fullText) as unknown;
      fullText = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
    } catch (e) { console.warn("[tuple-reconvert] collect JSON parse failed, passing through:", e); }
  }

  const hasToolCalls = toolCalls.length > 0;
  const message: ChatCompletionResponse["choices"][0]["message"] = {
    role: "assistant",
    content: fullText || null,
  };
  if (wantReasoning && fullReasoning) {
    message.reasoning_content = fullReasoning;
  }
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
        ...(cachedTokens != null
          ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
          : {}),
        ...(reasoningTokens != null
          ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
          : {}),
      },
    },
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cached_tokens: cachedTokens,
      reasoning_tokens: reasoningTokens,
    },
    responseId,
  };
}
