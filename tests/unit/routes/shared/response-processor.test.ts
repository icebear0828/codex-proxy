import { describe, it, expect, vi, beforeEach } from "vitest";

const recordedStreamCloseEvents = vi.hoisted((): Array<Record<string, unknown>> => []);

vi.mock("@src/logs/stream-close-event.js", () => ({
  recordStreamCloseEvent: vi.fn((evt: Record<string, unknown>) => {
    recordedStreamCloseEvents.push(evt);
  }),
}));

import { streamResponse } from "@src/routes/shared/response-processor.js";

/* ── Helpers ── */

function createMockStream() {
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
}) {
  const opts = options ?? {};
  return {
    tag: "Test",
    streamTranslator: vi.fn(async function* () {
      if (opts.streamError) throw opts.streamError;
      for (const chunk of opts.streamChunks ?? ["data: chunk1\n\n", "data: chunk2\n\n"]) {
        yield chunk;
      }
    }),
  };
}

function createMockCodexApi() {
  return {} as never; // response-processor passes it through, doesn't call methods
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

    await streamResponse(s as never, api, rawResponse, "gpt-5.4", adapter as never, onUsage);

    expect(s.written).toEqual(["a", "b", "c"]);
  });

  it("calls onUsage when adapter yields usage via callback", async () => {
    const s = createMockStream();
    const onUsage = vi.fn();
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    // streamTranslator that invokes usage callback
    const adapter = {
      tag: "Test",
      streamTranslator: vi.fn(async function* (
        _api: never, _res: Response, _model: string,
        usageCb: (u: { input_tokens: number; output_tokens: number }) => void,
      ) {
        yield "data: chunk\n\n";
        usageCb({ input_tokens: 5, output_tokens: 15 });
      }),
    };

    await streamResponse(s as never, api, rawResponse, "gpt-5.4", adapter as never, onUsage);

    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 5, output_tokens: 15 });
  });

  it("sends error SSE event when stream throws", async () => {
    const s = createMockStream();
    const adapter = createMockAdapter({ streamError: new Error("upstream died") });
    const api = createMockCodexApi();
    const rawResponse = new Response("ok");

    await streamResponse(s as never, api, rawResponse, "gpt-5.4", adapter as never, vi.fn());

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

    await streamResponse(
      s as never,
      api,
      rawResponse,
      "gpt-5.4",
      adapter as never,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { requestId: "rid-abort", tag: "Responses", abortSignal: abortController.signal },
    );

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

    await streamResponse(s as never, api, rawResponse, "gpt-5.4", adapter as never, vi.fn());

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
    await streamResponse(s as never, api, rawResponse, "gpt-5.4", adapter as never, vi.fn());

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

    await streamResponse(
      s as never,
      api,
      rawResponse,
      "gpt-5.4",
      adapter as never,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      { requestId: "rid-terminal", tag: "Responses" },
    );

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
