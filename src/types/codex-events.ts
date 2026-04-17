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

export interface CodexReasoningSummaryPartAddedEvent {
  type: "response.reasoning_summary_part.added";
  itemId: string;
  outputIndex: number;
  part: Record<string, unknown>;
}

export interface CodexReasoningSummaryPartDoneEvent {
  type: "response.reasoning_summary_part.done";
  itemId: string;
  outputIndex: number;
  part: Record<string, unknown>;
}

// ── Function call event data shapes ─────────────────────────────

export interface CodexOutputItemAddedEvent {
  type: "response.output_item.added";
  outputIndex: number;
  item: {
    type: string;
    id: string;
    call_id?: string;
    name?: string;
  };
}

export interface CodexContentPartAddedEvent {
  type: "response.content_part.added";
  contentIndex: number;
  outputIndex: number;
  itemId: string;
  part: Record<string, unknown>;
}

export interface CodexContentPartDoneEvent {
  type: "response.content_part.done";
  contentIndex: number;
  outputIndex: number;
  itemId: string;
  part: Record<string, unknown>;
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
    content?: unknown[];
    actions?: unknown[];
    [key: string]: unknown;
  };
}

export interface CodexOutputTextAnnotationAddedEvent {
  type: "response.output_text.annotation.added";
  outputIndex: number;
  contentIndex: number;
  annotationIndex: number;
  annotation: Record<string, unknown>;
}

export interface CodexWebSearchCallEvent {
  type:
    | "response.web_search_call.in_progress"
    | "response.web_search_call.searching"
    | "response.web_search_call.completed";
  outputIndex: number;
  itemId: string;
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
  | CodexReasoningSummaryPartAddedEvent
  | CodexReasoningSummaryPartDoneEvent
  | CodexCompletedEvent
  | CodexOutputItemAddedEvent
  | CodexOutputItemDoneEvent
  | CodexOutputTextAnnotationAddedEvent
  | CodexWebSearchCallEvent
  | CodexContentPartAddedEvent
  | CodexContentPartDoneEvent
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

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function getErrorRecord(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.error)) return data.error;
  if (isRecord(data.response) && isRecord(data.response.error)) return data.response.error;
  return data;
}

export function extractCodexError(data: unknown): { type: string; code: string; message: string } {
  const err = getErrorRecord(data);
  if (!err) {
    const message = safeStringify(data);
    return {
      type: "error",
      code: message.trimStart().startsWith("{") ? "malformed_error_event" : "unknown",
      message,
    };
  }

  const dataRecord = isRecord(data) ? data : {};
  const response = isRecord(dataRecord.response) ? dataRecord.response : {};
  const message =
    firstString(
      err.message,
      err.detail,
      err.error_description,
      dataRecord.message,
      dataRecord.detail,
      response.message,
      response.detail,
    ) ?? safeStringify(data);

  const type = firstString(err.type, dataRecord.type) ?? "error";
  const code =
    firstString(err.code, response.code) ??
    (type !== "error" && type !== "response.failed" ? type : "unknown");

  return { type, code, message };
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
    case "response.output_text.annotation.added": {
      if (isRecord(data) && isRecord(data.annotation)) {
        return {
          type: "response.output_text.annotation.added",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          contentIndex: typeof data.content_index === "number" ? data.content_index : 0,
          annotationIndex: typeof data.annotation_index === "number" ? data.annotation_index : 0,
          annotation: data.annotation,
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
    case "response.web_search_call.completed": {
      if (isRecord(data)) {
        return {
          type: evt.event,
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          itemId: typeof data.item_id === "string" ? data.item_id : "",
        };
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
    case "response.reasoning_summary_part.added": {
      if (isRecord(data) && isRecord(data.part)) {
        return {
          type: "response.reasoning_summary_part.added",
          itemId: typeof data.item_id === "string" ? data.item_id : "",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          part: data.part,
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.reasoning_summary_part.done": {
      if (isRecord(data) && isRecord(data.part)) {
        return {
          type: "response.reasoning_summary_part.done",
          itemId: typeof data.item_id === "string" ? data.item_id : "",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          part: data.part,
        };
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
      if (isRecord(data) && isRecord(data.item) && typeof data.item.type === "string") {
        const item: CodexOutputItemAddedEvent["item"] = {
          type: data.item.type,
          id: typeof data.item.id === "string" ? data.item.id : "",
        };
        if (typeof data.item.call_id === "string") item.call_id = data.item.call_id;
        if (typeof data.item.name === "string") item.name = data.item.name;
        return {
          type: "response.output_item.added",
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          item,
        };
      }
      return { type: "unknown", raw: data };
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      if (isRecord(data) && isRecord(data.part)) {
        return {
          type: evt.event as "response.content_part.added" | "response.content_part.done",
          contentIndex: typeof data.content_index === "number" ? data.content_index : 0,
          outputIndex: typeof data.output_index === "number" ? data.output_index : 0,
          itemId: typeof data.item_id === "string" ? data.item_id : "",
          part: data.part as Record<string, unknown>,
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
      return {
        type: "error",
        error: extractCodexError(data),
      };
    }
    case "response.failed": {
      const resp = parseResponseData(data);
      if (isRecord(data)) {
        return {
          type: "response.failed",
          error: extractCodexError(data),
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
            ...(Array.isArray(data.item.content) ? { content: data.item.content } : {}),
            ...(Array.isArray(data.item.actions) ? { actions: data.item.actions } : {}),
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
