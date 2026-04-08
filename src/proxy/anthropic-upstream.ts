/**
 * AnthropicUpstream — UpstreamAdapter for Anthropic Messages API.
 *
 * createResponse(): Translates CodexResponsesRequest → Anthropic Messages,
 *                   makes HTTP call, returns raw Response.
 * parseStream():    Normalizes Anthropic SSE events → CodexSSEEvent format.
 *
 * Anthropic SSE format uses `event:` + `data:` fields:
 *   event: message_start     → response.created
 *   event: content_block_delta (text_delta)    → response.output_text.delta
 *   event: content_block_delta (input_json_delta) → response.function_call_arguments.delta
 *   event: content_block_start (tool_use)      → response.output_item.added
 *   event: message_delta     → accumulate usage + stop_reason
 *   event: message_stop      → response.completed
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import { translateCodexToAnthropicRequest } from "../translation/codex-request-to-anthropic.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractModelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

export class AnthropicUpstream implements UpstreamAdapter {
  readonly tag = "anthropic" as const;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const modelId = extractModelId(req.model);
    const body = translateCodexToAnthropicRequest(req, modelId);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
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
    const fallbackId = `anthropic-${randomUUID().slice(0, 8)}`;
    let messageId = fallbackId;
    let inputTokens = 0;
    let outputTokens = 0;

    // Track tool_use content blocks by index → { id, name, argBuffer }
    const toolBlocks = new Map<number, { id: string; name: string; argBuffer: string }>();

    for await (const raw of parseSSEStream(response)) {
      // Anthropic SSE uses event: field — raw.event = "message_start", etc.
      const evtType = raw.event;
      if (!isRecord(raw.data)) continue;
      const data = raw.data;

      switch (evtType) {
        case "message_start": {
          const msg = isRecord(data.message) ? data.message : null;
          if (msg) {
            if (typeof msg.id === "string") messageId = msg.id;
            const usage = isRecord(msg.usage) ? msg.usage : null;
            if (usage && typeof usage.input_tokens === "number") {
              inputTokens = usage.input_tokens;
            }
          }
          yield {
            event: "response.created",
            data: { response: { id: messageId } },
          };
          break;
        }

        case "content_block_start": {
          const block = isRecord(data.content_block) ? data.content_block : null;
          const index = typeof data.index === "number" ? data.index : 0;
          if (block?.type === "tool_use") {
            const toolId = typeof block.id === "string" ? block.id : `call_${randomUUID().slice(0, 8)}`;
            const toolName = typeof block.name === "string" ? block.name : "";
            toolBlocks.set(index, { id: toolId, name: toolName, argBuffer: "" });
            yield {
              event: "response.output_item.added",
              data: {
                output_index: index,
                item: {
                  type: "function_call",
                  id: `item_${index}`,
                  call_id: toolId,
                  name: toolName,
                },
              },
            };
          }
          break;
        }

        case "content_block_delta": {
          const delta = isRecord(data.delta) ? data.delta : null;
          const index = typeof data.index === "number" ? data.index : 0;
          if (!delta) break;

          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield {
              event: "response.output_text.delta",
              data: { delta: delta.text },
            };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const tool = toolBlocks.get(index);
            if (tool) {
              tool.argBuffer += delta.partial_json;
              yield {
                event: "response.function_call_arguments.delta",
                data: { call_id: tool.id, delta: delta.partial_json, output_index: index },
              };
            }
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            // Map thinking deltas to reasoning summary deltas
            yield {
              event: "response.reasoning_summary_text.delta",
              data: { delta: delta.thinking },
            };
          }
          break;
        }

        case "content_block_stop": {
          const index = typeof data.index === "number" ? data.index : -1;
          const tool = toolBlocks.get(index);
          if (tool) {
            yield {
              event: "response.function_call_arguments.done",
              data: { call_id: tool.id, name: tool.name, arguments: tool.argBuffer, output_index: index },
            };
          }
          break;
        }

        case "message_delta": {
          const usage = isRecord(data.usage) ? data.usage : null;
          if (usage && typeof usage.output_tokens === "number") {
            outputTokens = usage.output_tokens;
          }
          break;
        }

        case "message_stop": {
          yield {
            event: "response.completed",
            data: {
              response: {
                id: messageId,
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
          break;
        }

        case "error": {
          const err = isRecord(data.error) ? data.error : data;
          yield {
            event: "error",
            data: {
              error: {
                type: typeof err.type === "string" ? err.type : "error",
                code: typeof err.type === "string" ? err.type : "api_error",
                message: typeof err.message === "string" ? err.message : JSON.stringify(data),
              },
            },
          };
          break;
        }
      }
    }
  }
}
