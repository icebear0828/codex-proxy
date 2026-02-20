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
          const chunk: GeminiGenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [{ text: delta }],
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
        const resp = data.response as Record<string, unknown> | undefined;
        if (resp?.usage) {
          const u = resp.usage as Record<string, number>;
          inputTokens = u.input_tokens ?? 0;
          outputTokens = u.output_tokens ?? 0;
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
