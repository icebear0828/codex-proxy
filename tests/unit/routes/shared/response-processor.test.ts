import { describe, it, expect, vi, beforeEach } from "vitest";
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
});

