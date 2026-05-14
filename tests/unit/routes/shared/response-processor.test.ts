import { describe, it, expect, vi, beforeEach } from "vitest";

const recordedStreamCloseEvents = vi.hoisted((): Array<Record<string, unknown>> => []);

vi.mock("@src/logs/stream-close-event.js", () => ({
  recordStreamCloseEvent: vi.fn((evt: Record<string, unknown>) => {
    recordedStreamCloseEvents.push(evt);
  }),
}));

import { streamResponse } from "@src/routes/shared/response-processor.js";
import type { StreamWriter } from "@src/routes/shared/response-processor.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "@src/proxy/codex-api.js";
import type { FormatAdapter, FormatStreamTranslatorOptions } from "@src/routes/shared/proxy-handler-types.js";

/* ── Helpers ── */

interface MockStream extends StreamWriter {
  written: string[];
  write: ReturnType<typeof vi.fn>;
  onAbort: ReturnType<typeof vi.fn>;
  triggerAbort: () => void;
}

function createMockStream(): MockStream {
  const written: string[] = [];
  let abortCb: (() => void) | undefined;
  return {
    written,
    write: vi.fn(async (chunk: string) => { written.push(chunk); }),
    onAbort: vi.fn((cb: () => void) => { abortCb = cb; }),
    triggerAbort: () => abortCb?.(),
  };
}

function createMockAdapter(options?: {
  streamChunks?: string[];
  streamError?: Error;
}): FormatAdapter {
  const opts = options ?? {};
  return {
    tag: "Test",
    noAccountStatus: 503,
    formatNoAccount: vi.fn(() => ({ error: "no_account" })),
    format429: vi.fn((message: string) => ({ error: "rate_limited", message })),
    formatError: vi.fn((status: number, message: string) => ({ error: "api_error", status, message })),
    streamTranslator: vi.fn(async function* (_options: FormatStreamTranslatorOptions) {
      if (opts.streamError) throw opts.streamError;
      for (const chunk of opts.streamChunks ?? ["data: chunk1\n\n", "data: chunk2\n\n"]) {
        yield chunk;
      }
    }),
    collectTranslator: vi.fn(async () => ({
      response: {},
      usage: { input_tokens: 0, output_tokens: 0 },
      responseId: null,
    })),
  };
}

function createMockCodexApi(): UpstreamAdapter {
  return {
    tag: "test",
    createResponse: vi.fn((_req: CodexResponsesRequest, _signal: AbortSignal) =>
      Promise.resolve(new Response("ok")),
    ),
    parseStream: vi.fn(async function* (_response: Response): AsyncGenerator<CodexSSEEvent> {}),
  };
}

describe("streamResponse", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    recordedStreamCloseEvents.length = 0;
  });

  it("writes all chunks to the stream", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamChunks: ["a", "b", "c"] });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");
    const onUsage = vi.fn();

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage,
    });

    expect(s.written).toEqual(["a", "b", "c"]);
  });

  it("passes translator dependencies as one options object", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamChunks: ["data: done\n\n"] });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");
    const onUsage = vi.fn();
    const onResponseId = vi.fn();
    const onResponseCompleted = vi.fn();
    const onResponseMetadata = vi.fn();
    const tupleSchema = { type: "array", prefixItems: [] } satisfies Record<string, unknown>;
    const usageHint = { reusedInputTokensUpperBound: 42 };

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage,
      tupleSchema,
      onResponseId,
      onResponseCompleted,
      usageHint,
      onResponseMetadata,
      diagnostics: {
        requestId: "rid-options",
        tag: "Responses",
        provider: "codex",
        path: "/codex/responses",
        accountEntryId: "entry-1",
        variantHash: "variant-1",
      },
    });

    const call = adapter.streamTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    const options = call[0] as Record<string, unknown>;
    expect(options.api).toBe(api);
    expect(options.response).toBe(rawResponse);
    expect(options.model).toBe("gpt-5.4");
    expect(options.onUsage).toBe(onUsage);
    expect(options.onResponseId).toBe(onResponseId);
    expect(options.onResponseCompleted).toBe(onResponseCompleted);
    expect(options.tupleSchema).toBe(tupleSchema);
    expect(options.usageHint).toBe(usageHint);
    expect(options.onResponseMetadata).toBe(onResponseMetadata);
    expect(options.streamContext).toEqual({
      requestId: "rid-options",
      tag: "Responses",
      provider: "codex",
      path: "/codex/responses",
      model: "gpt-5.4",
      accountEntryId: "entry-1",
      variantHash: "variant-1",
    });
  });

  it("forwards the abort signal to adapter stream context", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamChunks: ["data: done\n\n"] });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");
    const abortController = new AbortController();

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
      diagnostics: {
        requestId: "rid-abort-signal",
        tag: "Responses",
        abortSignal: abortController.signal,
      },
    });

    const call = adapter.streamTranslator.mock.calls[0] ?? [];
    const options = call[0] as FormatStreamTranslatorOptions;
    expect(options.streamContext?.abortSignal).toBe(abortController.signal);
  });

  it("calls onUsage when adapter yields usage via callback", async () => {
    const s = createMockStream();
    const onUsage = vi.fn();
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    // streamTranslator that invokes usage callback
    const adapter = {
      tag: "Test",
      noAccountStatus: 503,
      formatNoAccount: vi.fn(() => ({ error: "no_account" })),
      format429: vi.fn((message: string) => ({ error: "rate_limited", message })),
      formatError: vi.fn((status: number, message: string) => ({ error: "api_error", status, message })),
      streamTranslator: vi.fn(async function* (options: FormatStreamTranslatorOptions) {
        yield "data: chunk\n\n";
        options.onUsage({ input_tokens: 5, output_tokens: 15 });
      }),
      collectTranslator: vi.fn(async () => ({
        response: {},
        usage: { input_tokens: 0, output_tokens: 0 },
        responseId: null,
      })),
    };

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 5, output_tokens: 15 });
  });

  it("sends error SSE event when stream throws", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamError: new Error("upstream died") });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
    });

    // Should have attempted to write an error event
    const errorChunk = s.written.find((c) => c.includes("stream_error"));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain("upstream died");
  });

  it("does not record upstream-error when the request abort caused the stream failure", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamError: new Error("Aborted") });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");
    const abortController = new AbortController();
    abortController.abort();

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
      diagnostics: { requestId: "rid-abort", tag: "Responses", abortSignal: abortController.signal },
    });

    expect(recordedStreamCloseEvents).toEqual([]);
  });

  it("uses a protocol-specific stream error formatter when stream throws", async () => {
    const s = createMockStream();
    const adapter = {
      ...createMockAdapter({ streamError: new Error("error sending request for url") }),
      formatStreamError: vi.fn(
        (status: number, message: string) =>
          `event: response.failed\ndata: ${JSON.stringify({ status, message })}\n\n`,
      ),
    };
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
    });

    expect(adapter.formatStreamError).toHaveBeenCalledWith(502, "error sending request for url");
    expect(s.written.at(-1)).toBe(
      `event: response.failed\ndata: ${JSON.stringify({ status: 502, message: "error sending request for url" })}\n\n`,
    );
  });

  it("handles client disconnect during write gracefully", async () => {
    const s = createMockStream();
    s.write.mockRejectedValueOnce(new Error("client gone"));
    const adapter = createMockAdapter({ streamChunks: ["a", "b"] });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    // Should not throw
    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
    });

    // Only attempted first write which failed
    expect(s.write).toHaveBeenCalledTimes(1);
  });

  it("logs whether a client disconnect happened while writing the terminal event", async () => {
    const s = createMockStream();
    s.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("client gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = createMockAdapter({
      streamChunks: [
        "event: response.created\ndata: {}\n\n",
        "event: response.completed\ndata: {}\n\n",
      ],
    });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    await streamResponse({
      writer: s,
      api,
      response: rawResponse,
      model: "gpt-5.4",
      adapter,
      onUsage: vi.fn(),
      diagnostics: { requestId: "rid-terminal", tag: "Responses" },
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[stream-client-disconnect] rid=rid-terminal tag=Responses model=gpt-5.4"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("last_sent_event=response.created"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed_chunk_event=response.completed failed_chunk_terminal=true"),
    );
  });
});
