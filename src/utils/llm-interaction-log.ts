import type { CodexResponsesRequest, CodexSSEEvent } from "../proxy/codex-api.js";
import { log } from "./logger.js";

export interface LlmInteractionContext {
  rid: string;
  tag: string;
  entryId: string;
  clientModel: string;
  upstreamModel: string;
  isStreaming: boolean;
}

interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

interface ToolCallInfo {
  name: string;
  arguments: string;
}

interface StreamFinishOptions {
  error?: unknown;
}

const MAX_LOG_STRING = 1600;
const MAX_LOG_ARRAY_ITEMS = 12;
const MAX_LOG_OBJECT_KEYS = 40;

function truncateString(value: string, max = MAX_LOG_STRING): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => truncateForLog(item, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_LOG_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  const entries = Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    out[key] = truncateForLog(entryValue, seen);
  }
  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    out.__truncated_keys = entries.length - MAX_LOG_OBJECT_KEYS;
  }
  return out;
}

function summarizeContent(content: unknown): string {
  if (typeof content === "string") return truncateString(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "input_text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? truncateString(part.image_url, 120) : "";
      parts.push(`[image] ${url}`);
    }
  }
  return truncateString(parts.join("\n"));
}

function summarizeInput(request: CodexResponsesRequest): string[] {
  return request.input.slice(0, 8).map((item) => {
    if ("role" in item) {
      return `${item.role}: ${summarizeContent(item.content)}`;
    }
    if (item.type === "function_call") {
      return `tool_call ${item.name}(${truncateString(item.arguments)})`;
    }
    if (item.type === "function_call_output") {
      return `tool_result ${item.call_id}: ${truncateString(item.output)}`;
    }
    return truncateString(JSON.stringify(item));
  });
}

function extractUsage(response: Record<string, unknown>): UsageInfo | undefined {
  const usage = isRecord(response.usage) ? response.usage : null;
  if (!usage) return undefined;

  const result: UsageInfo = {};
  if (typeof usage.input_tokens === "number") result.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") result.output_tokens = usage.output_tokens;

  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  if (inputDetails && typeof inputDetails.cached_tokens === "number") {
    result.cached_tokens = inputDetails.cached_tokens;
  }

  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  if (outputDetails && typeof outputDetails.reasoning_tokens === "number") {
    result.reasoning_tokens = outputDetails.reasoning_tokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function logCodexRequest(
  context: LlmInteractionContext,
  request: CodexResponsesRequest,
): void {
  const toolNames = Array.isArray(request.tools)
    ? request.tools
      .filter(isRecord)
      .map((tool) => (typeof tool.name === "string" ? tool.name : typeof tool.type === "string" ? tool.type : "unknown"))
    : [];

  log.info("[LLM] Upstream request", {
    rid: context.rid,
    route: context.tag,
    entryId: context.entryId,
    clientModel: context.clientModel,
    upstreamModel: context.upstreamModel,
    isStreaming: context.isStreaming,
    instructions: truncateString(request.instructions),
    inputPreview: summarizeInput(request),
    toolNames,
    payload: truncateForLog(request),
  });
}

export function createCodexStreamLogger(context: LlmInteractionContext): {
  observe: (event: CodexSSEEvent) => void;
  finish: (options?: StreamFinishOptions) => void;
} {
  const eventCounts: Record<string, number> = {};
  const itemIdToCallId = new Map<string, string>();
  const toolCalls = new Map<string, ToolCallInfo>();
  let responseId: string | null = null;
  let usage: UsageInfo | undefined;
  let text = "";
  let reasoning = "";
  let terminalState = "stream_closed";
  let finished = false;
  let terminalError: { code?: string; message?: string } | undefined;

  const resolveToolCall = (id: string): ToolCallInfo => {
    const existing = toolCalls.get(id);
    if (existing) return existing;
    const created = { name: "", arguments: "" };
    toolCalls.set(id, created);
    return created;
  };

  return {
    observe: (event) => {
      eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
      const data = event.data;

      switch (event.event) {
        case "response.created":
        case "response.in_progress":
        case "response.queued":
        case "response.incomplete":
        case "response.completed":
        case "response.failed": {
          if (isRecord(data) && isRecord(data.response)) {
            if (typeof data.response.id === "string") responseId = data.response.id;
            usage = extractUsage(data.response) ?? usage;
          }
          if (event.event === "response.completed") terminalState = "completed";
          if (event.event === "response.incomplete") terminalState = "incomplete";
          if (event.event === "response.failed") {
            terminalState = "failed";
            const error = isRecord(data) && isRecord(data.error) ? data.error : null;
            terminalError = error
              ? {
                code: typeof error.code === "string" ? error.code : undefined,
                message: typeof error.message === "string" ? error.message : truncateString(JSON.stringify(error)),
              }
              : undefined;
          }
          break;
        }

        case "response.output_text.delta":
          if (isRecord(data) && typeof data.delta === "string") text += data.delta;
          break;

        case "response.output_text.done":
          if (isRecord(data) && typeof data.text === "string" && data.text.length >= text.length) {
            text = data.text;
          }
          break;

        case "response.reasoning_summary_text.delta":
          if (isRecord(data) && typeof data.delta === "string") reasoning += data.delta;
          break;

        case "response.reasoning_summary_text.done":
          if (isRecord(data) && typeof data.text === "string" && data.text.length >= reasoning.length) {
            reasoning = data.text;
          }
          break;

        case "response.output_item.added":
          if (
            isRecord(data)
            && isRecord(data.item)
            && data.item.type === "function_call"
            && typeof data.item.call_id === "string"
          ) {
            if (typeof data.item.id === "string") {
              itemIdToCallId.set(data.item.id, data.item.call_id);
            }
            const toolCall = resolveToolCall(data.item.call_id);
            toolCall.name = typeof data.item.name === "string" ? data.item.name : toolCall.name;
          }
          break;

        case "response.function_call_arguments.delta":
          if (isRecord(data) && typeof data.delta === "string") {
            const toolId =
              typeof data.call_id === "string"
                ? data.call_id
                : typeof data.item_id === "string"
                  ? (itemIdToCallId.get(data.item_id) ?? data.item_id)
                  : "";
            if (toolId) {
              resolveToolCall(toolId).arguments += data.delta;
            }
          }
          break;

        case "response.function_call_arguments.done":
          if (isRecord(data)) {
            const toolId =
              typeof data.call_id === "string"
                ? data.call_id
                : typeof data.item_id === "string"
                  ? (itemIdToCallId.get(data.item_id) ?? data.item_id)
                  : "";
            if (toolId) {
              const toolCall = resolveToolCall(toolId);
              if (typeof data.name === "string") toolCall.name = data.name;
              if (typeof data.arguments === "string") toolCall.arguments = data.arguments;
            }
          }
          break;

        case "error":
          terminalState = "error";
          if (isRecord(data) && isRecord(data.error)) {
            terminalError = {
              code: typeof data.error.code === "string" ? data.error.code : undefined,
              message: typeof data.error.message === "string" ? data.error.message : truncateString(JSON.stringify(data.error)),
            };
          }
          break;
      }
    },

    finish: (options) => {
      if (finished) return;
      finished = true;

      const errorMessage = options?.error instanceof Error
        ? options.error.message
        : options?.error != null
          ? String(options.error)
          : undefined;
      const status = errorMessage ? "stream_error" : terminalState;
      const extra = {
        rid: context.rid,
        route: context.tag,
        entryId: context.entryId,
        clientModel: context.clientModel,
        upstreamModel: context.upstreamModel,
        isStreaming: context.isStreaming,
        status,
        responseId,
        usage,
        eventCounts,
        outputText: text ? truncateString(text) : undefined,
        reasoningSummary: reasoning ? truncateString(reasoning) : undefined,
        toolCalls: [...toolCalls.entries()].map(([callId, info]) => ({
          callId,
          name: info.name || undefined,
          arguments: info.arguments ? truncateString(info.arguments) : undefined,
        })),
        error: terminalError ?? (errorMessage ? { message: errorMessage } : undefined),
      };

      if (status === "completed") {
        log.info("[LLM] Upstream response", extra);
      } else {
        log.warn("[LLM] Upstream response", extra);
      }
    },
  };
}
