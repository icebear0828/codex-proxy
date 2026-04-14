/**
 * Codex event factories for translation tests.
 * Creates ExtractedEvent objects that mock iterateCodexEvents() output.
 */

import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import type { TypedCodexEvent } from "@src/types/codex-events.js";

/** Create a text delta event. */
export function createTextDelta(text: string): ExtractedEvent {
  return {
    typed: { type: "response.output_text.delta", delta: text },
    textDelta: text,
  };
}

/** Create a reasoning summary delta event. */
export function createReasoningDelta(text: string): ExtractedEvent {
  return {
    typed: { type: "response.reasoning_summary_text.delta", delta: text },
    reasoningDelta: text,
  };
}

/** Create a response.created event. */
export function createCreated(responseId: string): ExtractedEvent {
  return {
    typed: { type: "response.created", response: { id: responseId } },
    responseId,
  };
}

/** Create a response.completed event. */
export function createCompleted(
  responseId: string,
  usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number },
): ExtractedEvent {
  return {
    typed: {
      type: "response.completed",
      response: { id: responseId, ...(usage ? { usage } : {}) },
    },
    responseId,
    usage,
  };
}

/** Create a function call start event. */
export function createFunctionCallStart(
  callId: string,
  name: string,
  outputIndex = 0,
): ExtractedEvent {
  return {
    typed: {
      type: "response.output_item.added",
      outputIndex,
      item: { type: "function_call", id: `item_${callId}`, call_id: callId, name },
    },
    functionCallStart: { callId, name, outputIndex },
  };
}

/** Create a function call arguments delta event. */
export function createFunctionCallDelta(callId: string, delta: string): ExtractedEvent {
  return {
    typed: {
      type: "response.function_call_arguments.delta",
      delta,
      outputIndex: 0,
      call_id: callId,
    },
    functionCallDelta: { callId, delta },
  };
}

/** Create a function call done event. */
export function createFunctionCallDone(
  callId: string,
  name: string,
  args: string,
): ExtractedEvent {
  return {
    typed: {
      type: "response.function_call_arguments.done",
      arguments: args,
      call_id: callId,
      name,
    },
    functionCallDone: { callId, name, arguments: args },
  };
}

/** Create an error event. */
export function createError(code: string, message: string): ExtractedEvent {
  return {
    typed: {
      type: "error",
      error: { type: "error", code, message },
    },
    error: { code, message },
  };
}

/** Create a response.in_progress event. */
export function createInProgress(responseId: string): ExtractedEvent {
  return {
    typed: { type: "response.in_progress", response: { id: responseId } },
    responseId,
  };
}
