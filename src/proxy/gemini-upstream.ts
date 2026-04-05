/**
 * GeminiUpstream — UpstreamAdapter for Google Gemini API.
 *
 * createResponse(): Translates CodexResponsesRequest → Gemini generateContent,
 *                   makes HTTP call via SSE stream endpoint.
 * parseStream():    Normalizes Gemini SSE chunks → CodexSSEEvent format.
 *
 * Gemini streaming SSE format (alt=sse):
 *   Each `data:` line contains a GenerateContentResponse JSON object.
 *   Text is in candidates[0].content.parts[0].text
 *   Usage is in usageMetadata (may only appear in last chunk)
 *   Finish reason is in candidates[0].finishReason
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import { translateCodexToGeminiRequest } from "../translation/codex-request-to-gemini.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractModelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

export class GeminiUpstream implements UpstreamAdapter {
  readonly tag = "gemini" as const;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const modelId = extractModelId(req.model);
    const body = translateCodexToGeminiRequest(req);

    // Always use streaming endpoint; non-streaming requests also use it for simplicity
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(response.status, errorText);
    }

    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    const responseId = `gemini-${randomUUID().slice(0, 8)}`;
    let sentCreated = false;
    let inputTokens = 0;
    let outputTokens = 0;

    // Gemini tool call state: track by index
    const toolCalls = new Map<
      number,
      { id: string; name: string; argBuffer: string }
    >();

    for await (const raw of parseSSEStream(response)) {
      // Gemini SSE has no `event:` field — each data line is a GenerateContentResponse
      if (!isRecord(raw.data)) continue;
      const chunk = raw.data;

      if (!sentCreated) {
        yield {
          event: "response.created",
          data: { response: { id: responseId } },
        };
        sentCreated = true;
      }

      // Usage metadata (may appear in intermediate and final chunks)
      if (isRecord(chunk.usageMetadata)) {
        const u = chunk.usageMetadata;
        if (typeof u.promptTokenCount === "number") inputTokens = u.promptTokenCount;
        if (typeof u.candidatesTokenCount === "number") outputTokens = u.candidatesTokenCount;
      }

      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const content = isRecord(candidate.content) ? candidate.content : null;
        if (!content) continue;

        const parts = Array.isArray(content.parts) ? content.parts : [];
        let toolIndex = toolCalls.size;

        for (const part of parts) {
          if (!isRecord(part)) continue;

          if (typeof part.text === "string" && part.text.length > 0) {
            yield {
              event: "response.output_text.delta",
              data: { delta: part.text },
            };
          } else if (isRecord(part.functionCall)) {
            const fc = part.functionCall;
            const toolId = `call_${randomUUID().slice(0, 8)}`;
            const toolName = typeof fc.name === "string" ? fc.name : "";
            const toolArgs = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";

            toolCalls.set(toolIndex, { id: toolId, name: toolName, argBuffer: toolArgs });

            yield {
              event: "response.output_item.added",
              data: {
                output_index: toolIndex,
                item: {
                  type: "function_call",
                  id: `item_${toolIndex}`,
                  call_id: toolId,
                  name: toolName,
                },
              },
            };
            yield {
              event: "response.function_call_arguments.delta",
              data: { call_id: toolId, delta: toolArgs, output_index: toolIndex },
            };
            yield {
              event: "response.function_call_arguments.done",
              data: { call_id: toolId, name: toolName, arguments: toolArgs, output_index: toolIndex },
            };
            toolIndex++;
          } else if (isRecord(part.thought) || (typeof part.text === "string" && isRecord(candidate.content) && typeof (candidate.content as Record<string, unknown>).role === "string")) {
            // Thinking parts (Gemini 2.0 Flash Thinking)
            if (isRecord(part.thought) && typeof part.thought === "object") {
              // thinking part — skip or emit as reasoning
            }
          }
        }
      }
    }

    yield {
      event: "response.completed",
      data: {
        response: {
          id: responseId,
          status: "completed",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            input_tokens_details: {},
            output_tokens_details: {},
          },
        },
      },
    };
  }
}
