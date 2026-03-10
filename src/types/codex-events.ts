/**
 * Type-safe Codex SSE event definitions and type guards.
 *
 * The Codex Responses API sends these SSE events during streaming.
 * Using discriminated unions eliminates unsafe `as` casts in translators.
 */

import type { CodexSSEEvent } from "../proxy/codex-api.js";

// ── Event data shapes ────────────────────────────────────────────

export interface CodexResponseData {
  id?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  [key: string]: unknown;
}

export interface CodexCreatedEvent {
  type: "response.created";
  response: CodexResponseData;
}

export interface CodexInProgressEvent {
  type: "response.in_progress";
  response: CodexResponseData;
}

export interface CodexTextDeltaEvent {
  type: "response.output_text.delta";
  delta: string;
}

export interface CodexTextDoneEvent {
  type: "response.output_text.done";
  text: string;
}

export interface CodexCompletedEvent {
  type: "response.completed";
  response: CodexResponseData;
}

// ── Reasoning summary event data shapes ─────────────────────────

export interface CodexReasoningSummaryDeltaEvent {
  type: "response.reasoning_summary_text.delta";
  delta: string;
}

export interface CodexReasoningSummaryDoneEvent {
  type: "response.reasoning_summary_text.done";
  text: string;
}

// ── Function call event data shapes ─────────────────────────────

export interface CodexOutputItemAddedEvent {
  type: "response.output_item.added";
  outputIndex: number;
  item: {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
  };
}

export interface CodexFunctionCallArgsDeltaEvent {
  type: "response.function_call_arguments.delta";
  delta: string;
  outputIndex: number;
  call_id: string;
}

export interface CodexFunctionCallArgsDoneEvent {
  type: "response.function_call_arguments.done";
  arguments: string;
  call_id: string;
  name: string;
}

export interface CodexOutputItemDoneEvent {
  type: "response.output_item.done";
  outputIndex: number;
  item: {
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
}

export interface CodexIncompleteEvent {
  type: "response.incomplete";
  response: CodexResponseData;
}

export interface CodexQueuedEvent {
  type: "response.queued";
  response: CodexResponseData;
}

export interface CodexErrorEvent {
  type: "error";
  error: { type: string; code: string; message: string };
}

export interface CodexResponseFailedEvent {
  type: "response.failed";
  error: { type: string; code: string; message: string };
  response: CodexResponseData;
}

export interface CodexUnknownEvent {
  type: "unknown";
  raw: unknown;
}

export type TypedCodexEvent =
  | CodexCreatedEvent
  | CodexInProgressEvent
  | CodexTextDeltaEvent
  | CodexTextDoneEvent
  | CodexReasoningSummaryDeltaEvent
  | CodexReasoningSummaryDoneEvent
  | CodexCompletedEvent
  | CodexOutputItemAddedEvent
  | CodexOutputItemDoneEvent
  | CodexIncompleteEvent
  | CodexQueuedEvent
  | CodexFunctionCallArgsDeltaEvent
  | CodexFunctionCallArgsDoneEvent
  | CodexErrorEvent
  | CodexResponseFailedEvent
  | CodexUnknownEvent;

// ── Type guard / parser ──────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseResponseData(data: unknown): CodexResponseData | undefined {
  if (!isRecord(data)) return undefined;
  const resp = data.response;
  if (!isRecord(resp)) return undefined;
  const result: CodexResponseData = {};
  if (typeof resp.id === "string") result.id = resp.id;
  if (isRecord(resp.usage)) {
    result.usage = {
      input_tokens: typeof resp.usage.input_tokens === "number" ? resp.usage.input_tokens : 0,
      output_tokens: typeof resp.usage.output_tokens === "number" ? resp.usage.output_tokens : 0,
    };
    // Extract cached_tokens from input_tokens_details
    const inputDetails = isRecord(resp.usage.input_tokens_details) ? resp.usage.input_tokens_details : undefined;
    if (inputDetails && typeof inputDetails.cached_tokens === "number") {
      result.usage.cached_tokens = inputDetails.cached_tokens;
    }
    // Extract reasoning_tokens from output_tokens_details
    const outputDetails = isRecord(resp.usage.output_tokens_details) ? resp.usage.output_tokens_details : undefined;
    if (outputDetails && typeof outputDetails.reasoning_tokens === "number") {
      result.usage.reasoning_tokens = outputDetails.reasoning_tokens;
    }
  }
  return result;
}

/**
 * Parse a raw CodexSSEEvent into a typed event.
 * Safely extracts fields with runtime checks — no `as` casts.
 */
export function parseCodexEvent(evt: CodexSSEEvent): TypedCodexEvent {
  const data = evt.data;

  switch (evt.event) {
    case "response.created": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.created", response: resp }
        : { type: "unknown", raw: data };
    }
    case "response.in_progress": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.in_progress", response: resp }
        : { type: "unknown", raw: data };
    }
    case "response.output_text.delta": {
      if (isRecord(data) && typeof data.delta === "string") {
        return { type: "response.output_text.delta", delta: data.delta };
      }
      return { type: "unknown", raw: data };
    }
    case "response.output_text.done": {
      if (isRecord(data) && typeof data.text === "string") {
        return { type: "response.output_text.done", text: data.text };
      }
      return { type: "unknown", raw: data };
    }
    case "response.reasoning_summary_text.delta": {
      if (isRecord(data) && typeof data.delta === "string") {
        return { type: "response.reasoning_summary_text.delta", delta: data.delta };
      }
      return { type: "unknown", raw: data };
    }
    case "response.reasoning_summary_text.done": {
      if (isRecord(data) && typeof data.text === "string") {
        return { type: "response.reasoning_summary_text.done", text: data.text };
      }
      return { type: "unknown", raw: data };
    }
    case "response.completed": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.completed", response: resp }
        : { type: "unknown", raw: data };
    }
    case "response.output_item.added": {
      if (
        isRecord(data) &&
        isRecord(data.item) &&
        data.item.type === "function_call" &&
        typeof data.item.call_id === "string" &&
        typeof data.item.name === "string"
      ) {
        return {
          type: "response.output_item.added",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          item: {
            type: "function_call",
            id: typeof data.item.id === "string" ? data.item.id : "",
            call_id: data.item.call_id,
            name: data.item.name,
          },
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.function_call_arguments.delta": {
      // Codex uses item_id (not call_id) on delta events
      const deltaCallId = isRecord(data)
        ? (typeof data.call_id === "string" ? data.call_id : typeof data.item_id === "string" ? data.item_id : "")
        : "";
      if (
        isRecord(data) &&
        typeof data.delta === "string" &&
        deltaCallId
      ) {
        return {
          type: "response.function_call_arguments.delta",
          delta: data.delta,
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          call_id: deltaCallId,
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.function_call_arguments.done": {
      // Codex uses item_id (not call_id); name may be absent
      const doneCallId = isRecord(data)
        ? (typeof data.call_id === "string" ? data.call_id : typeof data.item_id === "string" ? data.item_id : "")
        : "";
      if (
        isRecord(data) &&
        typeof data.arguments === "string" &&
        doneCallId
      ) {
        return {
          type: "response.function_call_arguments.done",
          arguments: data.arguments,
          call_id: doneCallId,
          name: typeof data.name === "string" ? data.name : "",
        };
      }
      return { type: "unknown", raw: data };
    }
    case "error": {
      if (isRecord(data)) {
        const err = isRecord(data.error) ? data.error : data;
        return {
          type: "error",
          error: {
            type: typeof err.type === "string" ? err.type : "error",
            code: typeof err.code === "string" ? err.code : "unknown",
            message: typeof err.message === "string" ? err.message : JSON.stringify(data),
          },
        };
      }
      return {
        type: "error",
        error: { type: "error", code: "unknown", message: String(data) },
      };
    }
    case "response.failed": {
      const resp = parseResponseData(data);
      if (isRecord(data)) {
        const err = isRecord(data.error) ? data.error : {};
        return {
          type: "response.failed",
          error: {
            type: typeof err.type === "string" ? err.type : "error",
            code: typeof err.code === "string" ? err.code : "unknown",
            message: typeof err.message === "string" ? err.message : JSON.stringify(data),
          },
          response: resp ?? {},
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.output_item.done": {
      if (isRecord(data) && isRecord(data.item)) {
        return {
          type: "response.output_item.done",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          item: {
            type: typeof data.item.type === "string" ? data.item.type : "unknown",
            ...(typeof data.item.id === "string" ? { id: data.item.id } : {}),
            ...(typeof data.item.call_id === "string" ? { call_id: data.item.call_id } : {}),
            ...(typeof data.item.name === "string" ? { name: data.item.name } : {}),
            ...(typeof data.item.arguments === "string" ? { arguments: data.item.arguments } : {}),
          },
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.incomplete": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.incomplete", response: resp }
        : { type: "unknown", raw: data };
    }
    case "response.queued": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.queued", response: resp }
        : { type: "unknown", raw: data };
    }
    default:
      return { type: "unknown", raw: data };
  }
}
