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
import type { CodexSSEEvent, CodexApi } from "../proxy/codex-api.js";
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../types/openai.js";

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
}

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
): AsyncGenerator<string> {
  const chunkId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let responseId: string | null = null;

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

  for await (const evt of codexApi.parseStream(rawResponse)) {
    const data = evt.data as Record<string, unknown>;

    switch (evt.event) {
      case "response.created":
      case "response.in_progress": {
        // Extract response ID for headers
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.id) responseId = resp.id as string;
        break;
      }

      case "response.output_text.delta": {
        // Streaming text delta
        const delta = (data.delta as string) ?? "";
        if (delta) {
          yield formatSSE({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: delta },
                finish_reason: null,
              },
            ],
          });
        }
        break;
      }

      case "response.completed": {
        // Extract and report usage
        if (onUsage) {
          const resp = data.response as Record<string, unknown> | undefined;
          if (resp?.usage) {
            const u = resp.usage as Record<string, number>;
            onUsage({
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
            });
          }
        }
        // Send final chunk with finish_reason
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
        break;
      }

      // Ignore other events (reasoning, content_part, output_item, etc.)
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
): Promise<{ response: ChatCompletionResponse; usage: UsageInfo }> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const evt of codexApi.parseStream(rawResponse)) {
    const data = evt.data as Record<string, unknown>;

    switch (evt.event) {
      case "response.output_text.delta": {
        const delta = (data.delta as string) ?? "";
        fullText += delta;
        break;
      }

      case "response.completed": {
        // Try to extract usage from the completed response
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.usage) {
          const usage = resp.usage as Record<string, number>;
          promptTokens = usage.input_tokens ?? 0;
          completionTokens = usage.output_tokens ?? 0;
        }
        break;
      }
    }
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
          message: {
            role: "assistant",
            content: fullText,
          },
          finish_reason: "stop",
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
  };
}
