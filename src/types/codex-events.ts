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

export interface CodexUnknownEvent {
  type: "unknown";
  raw: unknown;
}

export type TypedCodexEvent =
  | CodexCreatedEvent
  | CodexInProgressEvent
  | CodexTextDeltaEvent
  | CodexTextDoneEvent
  | CodexCompletedEvent
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
    case "response.completed": {
      const resp = parseResponseData(data);
      return resp
        ? { type: "response.completed", response: resp }
        : { type: "unknown", raw: data };
    }
    default:
      return { type: "unknown", raw: data };
  }
}
