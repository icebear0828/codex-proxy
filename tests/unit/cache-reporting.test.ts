/**
 * 验证缓存字段修复：cache_creation_input_tokens 和 cache_read_input_tokens
 * 正确从 Codex cached_tokens 映射到 Anthropic usage 格式。
 *
 * 不需要启动服务器，不需要真实账号，直接测翻译层。
 */

import { vi, describe, it, expect } from "vitest";
import type { CodexApi } from "@src/proxy/codex-api.js";
import {
  collectCodexToAnthropicResponse,
  streamCodexToAnthropic,
} from "@src/translation/codex-to-anthropic.js";

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * 构造一个伪造的 Codex SSE 流 Response，包含指定的 usage 数据。
 * 模拟 response.output_text.delta + response.completed 事件序列。
 */
function makeCodexResponse(opts: {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  text?: string;
}): Response {
  const { inputTokens, outputTokens, cachedTokens, text = "hello" } = opts;

  const events = [
    // 响应创建事件
    `event: response.created\ndata: ${JSON.stringify({
      response: { id: "resp_test_001" },
    })}\n\n`,
    // 文本输出
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      delta: text,
    })}\n\n`,
    // 完成事件，携带 usage（含 cached_tokens）
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: "resp_test_001",
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          input_tokens_details: cachedTokens != null ? { cached_tokens: cachedTokens } : {},
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })}\n\n`,
  ];

  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(event));
      }
      controller.close();
    },
  });

  return new Response(body, { status: 200 });
}

function makeToolCallCodexResponse(callId = "call_test_001"): Response {
  const itemId = "fc_item_001";
  const events = [
    `event: response.created\ndata: ${JSON.stringify({
      response: { id: "resp_tool_001" },
    })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      output_index: 0,
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: "test_tool",
      },
    })}\n\n`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      item_id: itemId,
      arguments: "{\"ok\":true}",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: "resp_tool_001",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: {},
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })}\n\n`,
  ];

  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(event));
      }
      controller.close();
    },
  });

  return new Response(body, { status: 200 });
}

/**
 * 构造一个最小化的 CodexApi mock，parseStream 直接解析 SSE 文本。
 */
function makeCodexApiMock(): CodexApi {
  return {
    parseStream: async function* (response: Response) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      // 简单解析 SSE 格式
      const blocks = buffer.split("\n\n").filter(Boolean);
      for (const block of blocks) {
        const lines = block.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event && data) {
          yield { event, data: JSON.parse(data) };
        }
      }
    },
  } as unknown as CodexApi;
}

// ── 非流式路径测试 ────────────────────────────────────────────────

describe("非流式响应 collectCodexToAnthropicResponse", () => {
  it("无缓存时：cache_creation = input_tokens，cache_read 不出现", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({ inputTokens: 10000, outputTokens: 500 });

    const { response } = await collectCodexToAnthropicResponse(api, res, "gpt-5.4");

    expect(response.usage.cache_creation_input_tokens).toBe(10000);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
    expect(response.usage.input_tokens).toBe(10000);
    expect(response.usage.output_tokens).toBe(500);
  });

  it("缓存全部命中时：cache_read = cached_tokens，cache_creation = input - cached", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 10000,
      outputTokens: 500,
      cachedTokens: 7000,
    });

    const { response } = await collectCodexToAnthropicResponse(api, res, "gpt-5.4");

    expect(response.usage.cache_read_input_tokens).toBe(7000);
    expect(response.usage.cache_creation_input_tokens).toBe(3000); // 10000 - 7000
    expect(response.usage.input_tokens).toBe(10000);
  });

  it("cachedTokens = 0 时：与无缓存情况一致，cache_read 不出现", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 5000,
      outputTokens: 200,
      cachedTokens: 0,
    });

    const { response } = await collectCodexToAnthropicResponse(api, res, "gpt-5.4");

    expect(response.usage.cache_creation_input_tokens).toBe(5000);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
  });

  it("大请求场景：70M input，1.18M cached（模拟 04-03 gpt-5.4）", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 70_000_000,
      outputTokens: 300_000,
      cachedTokens: 1_183_600,
    });

    const { response } = await collectCodexToAnthropicResponse(api, res, "gpt-5.4");

    expect(response.usage.cache_read_input_tokens).toBe(1_183_600);
    expect(response.usage.cache_creation_input_tokens).toBe(70_000_000 - 1_183_600);
    // cache_read / input 命中率
    const hitRate = 1_183_600 / 70_000_000;
    expect(hitRate).toBeCloseTo(0.017, 2); // 约 1.7%，对应实际数据
  });

  it("隐式续链但上游未返回 cached_tokens 时：使用复用上限推导 cache_read", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 15_243,
      outputTokens: 7,
      cachedTokens: 0,
    });

    const { response } = await collectCodexToAnthropicResponse(
      api,
      res,
      "gpt-5.4-mini",
      false,
      { reusedInputTokensUpperBound: 15_240 },
    );

    expect(response.usage.cache_read_input_tokens).toBe(15_240);
    expect(response.usage.cache_creation_input_tokens).toBe(3);
  });

  it("工具调用响应会回传 call_id 元数据，供隐式续链接力校验", async () => {
    const api = makeCodexApiMock();
    const res = makeToolCallCodexResponse("call_for_collect");
    const metadataCallIds: string[] = [];

    await collectCodexToAnthropicResponse(
      api,
      res,
      "gpt-5.4-mini",
      false,
      undefined,
      (metadata) => metadataCallIds.push(...(metadata.functionCallIds ?? [])),
    );

    expect(metadataCallIds).toEqual(["call_for_collect"]);
  });
});

// ── 流式路径测试 ──────────────────────────────────────────────────

describe("流式响应 streamCodexToAnthropic", () => {
  async function collectSSE(gen: AsyncGenerator<string>): Promise<string> {
    let result = "";
    for await (const chunk of gen) result += chunk;
    return result;
  }

  function parseMessageDelta(sseText: string): Record<string, unknown> | null {
    const lines = sseText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "event: message_delta" && lines[i + 1]?.startsWith("data: ")) {
        return JSON.parse(lines[i + 1].slice(6));
      }
    }
    return null;
  }

  it("无缓存时：message_delta.usage 包含 cache_creation，无 cache_read", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({ inputTokens: 8000, outputTokens: 400 });

    const sseText = await collectSSE(streamCodexToAnthropic(api, res, "gpt-5.4"));
    const delta = parseMessageDelta(sseText);

    expect(delta).not.toBeNull();
    const usage = (delta as any).usage;
    expect(usage.cache_creation_input_tokens).toBe(8000);
    expect(usage.cache_read_input_tokens).toBeUndefined();
  });

  it("缓存命中时：message_delta.usage 同时包含 cache_creation 和 cache_read", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 8000,
      outputTokens: 400,
      cachedTokens: 6000,
    });

    const sseText = await collectSSE(streamCodexToAnthropic(api, res, "gpt-5.4"));
    const delta = parseMessageDelta(sseText);

    const usage = (delta as any).usage;
    expect(usage.cache_read_input_tokens).toBe(6000);
    expect(usage.cache_creation_input_tokens).toBe(2000); // 8000 - 6000
  });

  it("多轮对话场景：第二轮缓存命中率应显著高于第一轮", async () => {
    const api = makeCodexApiMock();

    // 第一轮：全新对话，无缓存
    const res1 = makeCodexResponse({ inputTokens: 5000, outputTokens: 300 });
    const sse1 = await collectSSE(streamCodexToAnthropic(api, res1, "gpt-5.4"));
    const delta1 = parseMessageDelta(sse1) as any;
    expect(delta1.usage.cache_creation_input_tokens).toBe(5000);
    expect(delta1.usage.cache_read_input_tokens).toBeUndefined();

    // 第二轮：同一对话，大量缓存命中
    const res2 = makeCodexResponse({
      inputTokens: 5500, // 多了 500 新 token
      outputTokens: 280,
      cachedTokens: 4800, // 前 4800 命中缓存
    });
    const sse2 = await collectSSE(streamCodexToAnthropic(api, res2, "gpt-5.4"));
    const delta2 = parseMessageDelta(sse2) as any;
    expect(delta2.usage.cache_read_input_tokens).toBe(4800);
    expect(delta2.usage.cache_creation_input_tokens).toBe(700); // 5500 - 4800

    // 第二轮缓存命中率 >> 0
    const hitRate2 = delta2.usage.cache_read_input_tokens / 5500;
    expect(hitRate2).toBeGreaterThan(0.8); // 87% 命中率
  });

  it("流式场景下也会为隐式续链补齐 cache_read", async () => {
    const api = makeCodexApiMock();
    const res = makeCodexResponse({
      inputTokens: 15_243,
      outputTokens: 7,
      cachedTokens: 0,
    });

    const sseText = await collectSSE(
      streamCodexToAnthropic(api, res, "gpt-5.4-mini", undefined, undefined, false, {
        reusedInputTokensUpperBound: 15_240,
      }),
    );
    const delta = parseMessageDelta(sseText) as any;

    expect(delta.usage.cache_read_input_tokens).toBe(15_240);
    expect(delta.usage.cache_creation_input_tokens).toBe(3);
  });

  it("流式工具调用响应会回传 call_id 元数据", async () => {
    const api = makeCodexApiMock();
    const res = makeToolCallCodexResponse("call_for_stream");
    const metadataCallIds: string[] = [];

    await collectSSE(
      streamCodexToAnthropic(
        api,
        res,
        "gpt-5.4-mini",
        undefined,
        undefined,
        false,
        undefined,
        (metadata) => metadataCallIds.push(...(metadata.functionCallIds ?? [])),
      ),
    );

    expect(metadataCallIds).toEqual(["call_for_stream"]);
  });
});
