/**
 * SSE test utilities.
 * Provides mock Response objects and helpers for testing SSE stream processing.
 */

import type { CodexSSEEvent } from "@src/proxy/codex-api.js";

/** Create a Response whose body emits the given string chunks sequentially. */
export function mockResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  let idx = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]));
        idx++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream);
}

/** Format an SSE event string: "event: xxx\ndata: {...}\n\n" */
export function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Collect all items from an async generator into an array. */
export async function collectAsyncGen<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

/** Collect all events from CodexApi.parseStream into an array. */
export async function collectEvents(
  api: { parseStream(response: Response): AsyncGenerator<CodexSSEEvent> },
  response: Response,
): Promise<CodexSSEEvent[]> {
  return collectAsyncGen(api.parseStream(response));
}

/** Build a simple text-response SSE stream. */
export function buildTextStreamChunks(
  responseId: string,
  text: string,
  usage?: { input_tokens: number; output_tokens: number },
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("response.output_text.delta", { delta: text }) +
    sseChunk("response.completed", {
      response: {
        id: responseId,
        usage: usage ?? { input_tokens: 10, output_tokens: 5 },
      },
    })
  );
}

/** Build a tool/function call SSE stream. */
export function buildToolCallStreamChunks(
  responseId: string,
  callId: string,
  fnName: string,
  args: string,
  usage?: { input_tokens: number; output_tokens: number },
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("response.output_item.added", {
      outputIndex: 0,
      item: { type: "function_call", id: `item_${callId}`, call_id: callId, name: fnName },
    }) +
    sseChunk("response.function_call_arguments.delta", {
      delta: args,
      outputIndex: 0,
      call_id: callId,
    }) +
    sseChunk("response.function_call_arguments.done", {
      arguments: args,
      call_id: callId,
      name: fnName,
    }) +
    sseChunk("response.completed", {
      response: {
        id: responseId,
        usage: usage ?? { input_tokens: 20, output_tokens: 15 },
      },
    })
  );
}

/** Build a reasoning + text SSE stream. */
export function buildReasoningStreamChunks(
  responseId: string,
  reasoning: string,
  text: string,
  usage?: { input_tokens: number; output_tokens: number },
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("response.reasoning_summary_text.delta", { delta: reasoning }) +
    sseChunk("response.output_text.delta", { delta: text }) +
    sseChunk("response.completed", {
      response: {
        id: responseId,
        usage: usage ?? { input_tokens: 30, output_tokens: 25 },
      },
    })
  );
}

/** Build a SSE stream with detailed usage (cached_tokens, reasoning_tokens). */
export function buildDetailedUsageStreamChunks(
  responseId: string,
  text: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  },
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("response.output_text.delta", { delta: text }) +
    sseChunk("response.completed", {
      response: { id: responseId, usage },
    })
  );
}

/** Build an error SSE stream. */
export function buildErrorStreamChunks(
  responseId: string,
  code: string,
  message: string,
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("error", { error: { type: "error", code, message } })
  );
}

/** Build an empty SSE stream (no content, triggers EmptyResponseError in collect). */
export function buildEmptyStreamChunks(
  responseId: string,
  usage?: { input_tokens: number; output_tokens: number },
): string {
  return (
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } }) +
    sseChunk("response.completed", {
      response: {
        id: responseId,
        usage: usage ?? { input_tokens: 10, output_tokens: 0 },
      },
    })
  );
}

/** Build a multi-tool-call SSE stream. */
export function buildMultiToolCallStreamChunks(
  responseId: string,
  calls: Array<{ callId: string; name: string; args: string }>,
  usage?: { input_tokens: number; output_tokens: number },
): string {
  let sse =
    sseChunk("response.created", { response: { id: responseId } }) +
    sseChunk("response.in_progress", { response: { id: responseId } });

  for (let i = 0; i < calls.length; i++) {
    const { callId, name, args } = calls[i];
    sse += sseChunk("response.output_item.added", {
      outputIndex: i,
      item: { type: "function_call", id: `item_${callId}`, call_id: callId, name },
    });
    sse += sseChunk("response.function_call_arguments.done", {
      arguments: args,
      call_id: callId,
      name,
    });
  }

  sse += sseChunk("response.completed", {
    response: {
      id: responseId,
      usage: usage ?? { input_tokens: 15, output_tokens: 10 },
    },
  });

  return sse;
}
