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
  GeminiPart,
} from "../types/gemini.js";
import { iterateCodexEvents, EmptyResponseError } from "./codex-event-extractor.js";

export interface GeminiUsageInfo {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
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
  let cachedTokens: number | undefined;
  let hasContent = false;

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    // Handle upstream error events
    if (evt.error) {
      const errorChunk: GeminiGenerateContentResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: `[Error] ${evt.error.code}: ${evt.error.message}` }],
              role: "model",
            },
            finishReason: "OTHER",
            index: 0,
          },
        ],
        modelVersion: model,
      };
      yield `data: ${JSON.stringify(errorChunk)}\n\n`;
      return;
    }

    // Function call done → emit as a candidate with functionCall part
    if (evt.functionCallDone) {
      hasContent = true;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty args */ }
      const fcChunk: GeminiGenerateContentResponse = {
        candidates: [
          {
            content: {
              parts: [{
                functionCall: {
                  name: evt.functionCallDone.name,
                  args,
                },
              }],
              role: "model",
            },
            index: 0,
          },
        ],
        modelVersion: model,
      };
      yield `data: ${JSON.stringify(fcChunk)}\n\n`;
      continue;
    }

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          hasContent = true;
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
          yield `data: ${JSON.stringify(chunk)}\n\n`;
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
          const emptyErrChunk: GeminiGenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [{ text: "[Error] Codex returned an empty response. Please retry." }],
                  role: "model",
                },
                index: 0,
              },
            ],
            modelVersion: model,
          };
          yield `data: ${JSON.stringify(emptyErrChunk)}\n\n`;
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
            ...(cachedTokens != null ? { cachedContentTokenCount: cachedTokens } : {}),
          },
          modelVersion: model,
        };
        yield `data: ${JSON.stringify(finalChunk)}\n\n`;
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
  let cachedTokens: number | undefined;
  let responseId: string | null = null;
  const functionCallParts: GeminiPart[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.error) {
      throw new Error(`Codex API error: ${evt.error.code}: ${evt.error.message}`);
    }
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
      cachedTokens = evt.usage.cached_tokens;
    }
    if (evt.functionCallDone) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty args */ }
      functionCallParts.push({
        functionCall: { name: evt.functionCallDone.name, args },
      });
    }
  }

  const usage: GeminiUsageInfo = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedTokens != null ? { cached_tokens: cachedTokens } : {}),
  };

  const usageMetadata: GeminiUsageMetadata = {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
    ...(cachedTokens != null ? { cachedContentTokenCount: cachedTokens } : {}),
  };

  // Detect empty response (HTTP 200 but no content)
  if (!fullText && functionCallParts.length === 0 && outputTokens === 0) {
    throw new EmptyResponseError(responseId, { input_tokens: inputTokens, output_tokens: outputTokens });
  }

  // Build response parts: text + function calls
  const parts: GeminiPart[] = [];
  if (fullText) {
    parts.push({ text: fullText });
  }
  parts.push(...functionCallParts);
  if (parts.length === 0) {
    parts.push({ text: "" });
  }

  return {
    response: {
      candidates: [
        {
          content: {
            parts,
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
