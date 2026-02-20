/**
 * Translate Codex Responses API SSE stream → Google Gemini API format.
 *
 * Codex SSE events:
 *   response.created → extract response ID
 *   response.output_text.delta → streaming candidate with text part
 *   response.completed → final candidate with finishReason + usageMetadata
 *
 * Non-streaming: collect all text, return Gemini generateContent response.
 */

import type { CodexApi } from "../proxy/codex-api.js";
import type {
  GeminiGenerateContentResponse,
  GeminiUsageMetadata,
} from "../types/gemini.js";
import { iterateCodexEvents } from "./codex-event-extractor.js";

export interface GeminiUsageInfo {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Stream Codex Responses API events as Gemini SSE.
 * Yields string chunks ready to write to the HTTP response.
 */
export async function* streamCodexToGemini(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: GeminiUsageInfo) => void,
  onResponseId?: (id: string) => void,
): AsyncGenerator<string> {
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          const chunk: GeminiGenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [{ text: evt.textDelta }],
                  role: "model",
                },
                index: 0,
              },
            ],
            modelVersion: model,
          };
          yield `data: ${JSON.stringify(chunk)}\r\n\r\n`;
        }
        break;
      }

      case "response.completed": {
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens;
          outputTokens = evt.usage.output_tokens;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens });
        }

        // Final chunk with finishReason and usage
        const finalChunk: GeminiGenerateContentResponse = {
          candidates: [
            {
              content: {
                parts: [{ text: "" }],
                role: "model",
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: inputTokens,
            candidatesTokenCount: outputTokens,
            totalTokenCount: inputTokens + outputTokens,
          },
          modelVersion: model,
        };
        yield `data: ${JSON.stringify(finalChunk)}\r\n\r\n`;
        break;
      }
    }
  }
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * Gemini generateContent response.
 */
export async function collectCodexToGeminiResponse(
  codexApi: CodexApi,
  rawResponse: Response,
  model: string,
): Promise<{
  response: GeminiGenerateContentResponse;
  usage: GeminiUsageInfo;
  responseId: string | null;
}> {
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | null = null;

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
    }
  }

  const usage: GeminiUsageInfo = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const usageMetadata: GeminiUsageMetadata = {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
  };

  return {
    response: {
      candidates: [
        {
          content: {
            parts: [{ text: fullText }],
            role: "model",
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata,
      modelVersion: model,
    },
    usage,
    responseId,
  };
}
