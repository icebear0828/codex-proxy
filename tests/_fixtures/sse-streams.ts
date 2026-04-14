/**
 * Pre-defined SSE event sequences for translation tests.
 * Each export is a function returning ExtractedEvent[] (fresh copies each call).
 */

import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import {
  createCreated,
  createInProgress,
  createTextDelta,
  createReasoningDelta,
  createCompleted,
  createFunctionCallStart,
  createFunctionCallDelta,
  createFunctionCallDone,
  createError,
} from "@helpers/events.js";

/** Simplest text response stream. */
export function simpleTextStream(): ExtractedEvent[] {
  return [
    createCreated("resp_1"),
    createInProgress("resp_1"),
    createTextDelta("Hello"),
    createTextDelta(", world!"),
    createCompleted("resp_1", { input_tokens: 10, output_tokens: 5 }),
  ];
}

/** Stream with a single tool/function call. */
export function toolCallStream(): ExtractedEvent[] {
  return [
    createCreated("resp_2"),
    createInProgress("resp_2"),
    createFunctionCallStart("call_1", "get_weather", 0),
    createFunctionCallDelta("call_1", '{"loc'),
    createFunctionCallDelta("call_1", 'ation":"NYC"}'),
    createFunctionCallDone("call_1", "get_weather", '{"location":"NYC"}'),
    createCompleted("resp_2", { input_tokens: 20, output_tokens: 15 }),
  ];
}

/** Stream with reasoning summary deltas before text. */
export function reasoningStream(): ExtractedEvent[] {
  return [
    createCreated("resp_3"),
    createInProgress("resp_3"),
    createReasoningDelta("Let me think..."),
    createReasoningDelta(" I need to consider"),
    createTextDelta("The answer is 42."),
    createCompleted("resp_3", { input_tokens: 30, output_tokens: 25 }),
  ];
}

/** Error response stream. */
export function errorStream(): ExtractedEvent[] {
  return [
    createCreated("resp_4"),
    createInProgress("resp_4"),
    createError("rate_limit", "Too many requests"),
  ];
}

/** Empty response stream (no text, no tool calls — triggers EmptyResponseError). */
export function emptyStream(): ExtractedEvent[] {
  return [
    createCreated("resp_5"),
    createInProgress("resp_5"),
    createCompleted("resp_5", { input_tokens: 10, output_tokens: 0 }),
  ];
}

/** Stream with multiple tool calls. */
export function multiToolCallStream(): ExtractedEvent[] {
  return [
    createCreated("resp_6"),
    createInProgress("resp_6"),
    createFunctionCallStart("call_a", "search", 0),
    createFunctionCallDone("call_a", "search", '{"q":"hello"}'),
    createFunctionCallStart("call_b", "fetch", 1),
    createFunctionCallDone("call_b", "fetch", '{"url":"https://example.com"}'),
    createCompleted("resp_6", { input_tokens: 15, output_tokens: 10 }),
  ];
}

/** Stream with full usage including cached and reasoning tokens. */
export function usageStream(): ExtractedEvent[] {
  return [
    createCreated("resp_7"),
    createInProgress("resp_7"),
    createTextDelta("Result"),
    createCompleted("resp_7", { input_tokens: 50, output_tokens: 20, cached_tokens: 30, reasoning_tokens: 10 }),
  ];
}

/** Tool call stream with no argument deltas (only start + done). */
export function toolCallNoDeltaStream(): ExtractedEvent[] {
  return [
    createCreated("resp_8"),
    createInProgress("resp_8"),
    createFunctionCallStart("call_x", "do_thing", 0),
    createFunctionCallDone("call_x", "do_thing", '{"key":"value"}'),
    createCompleted("resp_8", { input_tokens: 10, output_tokens: 5 }),
  ];
}
