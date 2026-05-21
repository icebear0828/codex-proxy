import type { CodexApi } from "@src/proxy/codex-api.js";
import { collectNonStreamingResponse } from "@src/routes/shared/non-streaming-collect-response.js";
import type { FormatCollectTranslatorOptions, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";
import { describe, expect, it, vi } from "vitest";

function makeRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "client-model",
    isStreaming: false,
    codexRequest: {
      model: "codex-model",
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: true,
      store: false,
    },
    ...overrides,
  };
}

describe("collectNonStreamingResponse", () => {
  it("calls the collect translator and returns collected response metadata", async () => {
    const rawResponse = new Response("ok");
    const api = {} as unknown as CodexApi;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async (options: FormatCollectTranslatorOptions) => {
        options.onResponseMetadata?.({ functionCallIds: ["call-a", "call-b"] });
        options.onResponseMetadata?.({ functionCallIds: ["call-a", "call-c"] });
        return {
          response: { id: "resp_1" },
          usage: { input_tokens: 7, output_tokens: 11 },
          responseId: "resp_1",
        };
      }),
    });

    const result = await collectNonStreamingResponse({
      fmt,
      api,
      rawResponse,
      req: makeRequest({ tupleSchema: { type: "object" } }),
      usageHint: { reusedInputTokensUpperBound: 33 },
    });

    expect(result.result).toEqual({
      response: { id: "resp_1" },
      usage: { input_tokens: 7, output_tokens: 11 },
      responseId: "resp_1",
    });
    expect(Array.from(result.responseFunctionCallIds)).toEqual(["call-a", "call-b", "call-c"]);
    expect(fmt.collectTranslator).toHaveBeenCalledWith({
      api,
      response: rawResponse,
      model: "client-model",
      tupleSchema: { type: "object" },
      usageHint: { reusedInputTokensUpperBound: 33 },
      onResponseMetadata: expect.any(Function),
    });
  });

  it("rethrows collect translator failures without wrapping them", async () => {
    const err = new Error("collect failed");
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw err;
      }),
    });

    await expect(collectNonStreamingResponse({
      fmt,
      api: {} as unknown as CodexApi,
      rawResponse: new Response("ok"),
      req: makeRequest(),
    })).rejects.toBe(err);
  });
});
