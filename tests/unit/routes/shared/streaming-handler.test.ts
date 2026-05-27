import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SessionAffinityMap } from "@src/auth/session-affinity.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { CodexApi } from "@src/proxy/codex-api.js";
import { handleStreaming } from "@src/routes/shared/streaming-handler.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import type { FormatStreamTranslatorOptions } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

function createMockAccountPool(): { pool: AccountPool; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  return {
    pool: { release } as unknown as AccountPool,
    release,
  };
}

function createStreamingRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    },
    model: "codex",
    isStreaming: true,
    expectsImageGen: true,
  };
}

describe("handleStreaming", () => {
  const affinityMaps: SessionAffinityMap[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const affinityMap of affinityMaps) {
      affinityMap.dispose();
    }
    affinityMaps.length = 0;
  });

  it("records response affinity, aborts upstream, and releases with annotated usage", async () => {
    const { pool, release } = createMockAccountPool();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const affinityMap = new SessionAffinityMap();
    affinityMaps.push(affinityMap);
    const abortController = new AbortController();
    const fmt = createMockFormatAdapter({
      streamTranslator: vi.fn(async function* (options: FormatStreamTranslatorOptions) {
        options.onUsage({
          input_tokens: 10_001,
          output_tokens: 7,
          cached_tokens: 10,
          reasoning_tokens: 5,
          image_input_tokens: 3,
          image_output_tokens: 4,
        });
        options.onResponseId("resp_stream");
        options.onResponseMetadata?.({ functionCallIds: ["call_stream"] });
        options.onResponseCompleted?.("resp_stream");
        yield "event: response.completed\ndata: {}\n\n";
      }),
    });
    const app = new Hono();

    app.get("/stream", (c) => handleStreaming({
      c,
      accountPool: pool,
      req: createStreamingRequest(),
      fmt,
      api: {} as unknown as CodexApi,
      response: new Response(""),
      entryId: "entry-stream",
      abortController,
      released: new Set<string>(),
      requestId: "request-stream-123",
      affinityMap,
      conversationId: "conversation-stream",
      turnState: "turn-stream",
      usageHint: { reusedInputTokensUpperBound: 100 },
      variantHash: "variant-stream",
    }));

    const res = await app.request("/stream");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(text).toContain("event: response.completed");
    expect(abortController.signal.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("entry-stream", {
      input_tokens: 10_001,
      output_tokens: 7,
      cached_tokens: 10,
      reasoning_tokens: 5,
      image_input_tokens: 3,
      image_output_tokens: 4,
      image_request_attempted: true,
      image_request_succeeded: true,
    });
    expect(affinityMap.lookup("resp_stream")).toBe("entry-stream");
    expect(affinityMap.lookupConversationId("resp_stream")).toBe("conversation-stream");
    expect(affinityMap.lookupTurnState("resp_stream")).toBe("turn-stream");
    expect(affinityMap.lookupInstructionsHash("resp_stream")).toBe("58d0189aa8572b25a2e4ba09928df2c3d924d07f53de9aeb94ffe7f6f2a1de2b");
    expect(affinityMap.lookupInputTokens("resp_stream")).toBe(10_001);
    expect(affinityMap.lookupFunctionCallIds("resp_stream")).toEqual(["call_stream"]);
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "conversation-stream",
      undefined,
      "variant-stream",
    )).toBe("resp_stream");
    expect(logSpy).toHaveBeenCalledWith(
      "[Test] Account entry-stream | rid=request- | Usage: in=10001 (cached=10 uncached=9991) out=7 reasoning=5 image=3/4 | hit=0.1%",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[Test] ⚠ High input token count: 10001 tokens (reasoning=5)",
    );

    const call = fmt.streamTranslator.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    expect(call[0].usageHint).toEqual({ reusedInputTokensUpperBound: 100 });
    expect(call[0].streamContext).toMatchObject({
      requestId: "request-",
      tag: "Test",
      provider: "codex",
      path: "/codex/responses",
      model: "codex",
      accountEntryId: "entry-stream",
      variantHash: "variant-stream",
    });
  });

  it("does not record response affinity before upstream completion", async () => {
    const { pool } = createMockAccountPool();
    const affinityMap = new SessionAffinityMap();
    affinityMaps.push(affinityMap);
    const abortController = new AbortController();
    const fmt = createMockFormatAdapter({
      streamTranslator: vi.fn(async function* (options: FormatStreamTranslatorOptions) {
        options.onResponseId("resp_partial");
        yield "event: response.created\ndata: {\"response\":{\"id\":\"resp_partial\"}}\n\n";
        yield "event: response.failed\ndata: {\"response\":{\"id\":\"resp_partial\",\"status\":\"failed\"}}\n\n";
      }),
    });
    const app = new Hono();

    app.get("/stream", (c) => handleStreaming({
      c,
      accountPool: pool,
      req: createStreamingRequest(),
      fmt,
      api: {} as unknown as CodexApi,
      response: new Response(""),
      entryId: "entry-stream",
      abortController,
      released: new Set<string>(),
      requestId: "request-stream-123",
      affinityMap,
      conversationId: "conversation-stream",
      variantHash: "variant-stream",
    }));

    const res = await app.request("/stream");
    const text = await res.text();

    expect(text).toContain("event: response.failed");
    expect(affinityMap.lookup("resp_partial")).toBeNull();
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "conversation-stream",
      undefined,
      "variant-stream",
    )).toBeNull();
  });
});
