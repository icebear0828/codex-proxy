import { describe, it, expect } from "vitest";
import { calculateLogMetrics } from "../../../src/logs/metrics.js";
import { createPricingCatalog } from "../../../src/auth/usage-pricing.js";

describe("calculateLogMetrics", () => {
  const catalog = createPricingCatalog({
    "gpt-5.5": {
      input_usd_per_million: 3.0,
      cached_input_usd_per_million: 0.75,
      output_usd_per_million: 15.0,
    },
  });

  it("calculates TTFT, duration, cost, and tokens per second for streaming", () => {
    const metrics = calculateLogMetrics({
      startMs: 1000,
      firstTokenMs: 1200,
      endMs: 2000,
      model: "gpt-5.5",
      usage: {
        input_tokens: 1000,
        output_tokens: 40,
        cached_tokens: 500,
        reasoning_tokens: 10,
      },
      pricingCatalog: catalog,
    });

    expect(metrics.durationMs).toBe(1000);
    expect(metrics.ttftMs).toBe(200);
    // (500 * 3.0 + 500 * 0.75 + 40 * 15.0) / 1,000,000 = (1500 + 375 + 600) / 1,000,000 = 2475 / 1,000,000 = 0.002475
    expect(metrics.costUsd).toBeCloseTo(0.002475, 6);
    // streaming generation time = 2000 - 1200 = 800ms = 0.8s; tokens = 40; speed = 40 / 0.8 = 50 tokens/s
    expect(metrics.tokensPerSecond).toBe(50);
    expect(metrics.inputTokens).toBe(1000);
    expect(metrics.outputTokens).toBe(40);
    expect(metrics.cachedTokens).toBe(500);
    expect(metrics.reasoningTokens).toBe(10);
    expect(metrics.totalTokens).toBe(1040);
  });

  it("handles non-streaming requests where firstTokenMs is not provided", () => {
    const metrics = calculateLogMetrics({
      startMs: 1000,
      endMs: 3000,
      model: "gpt-5.5",
      usage: {
        input_tokens: 200,
        output_tokens: 100,
      },
      pricingCatalog: catalog,
    });

    expect(metrics.durationMs).toBe(2000);
    expect(metrics.ttftMs).toBe(2000);
    expect(metrics.tokensPerSecond).toBe(50); // 100 tokens / 2s = 50
  });

  it("sets ttftMs to null for streaming requests when firstTokenMs is null", () => {
    const metrics = calculateLogMetrics({
      startMs: 1000,
      firstTokenMs: null,
      endMs: 2500,
      model: "gpt-5.5",
      isStreaming: true,
      usage: {
        input_tokens: 100,
        output_tokens: 0,
      },
      pricingCatalog: catalog,
    });

    expect(metrics.durationMs).toBe(1500);
    expect(metrics.ttftMs).toBeNull();
  });

  it("handles zero output tokens gracefully", () => {
    const metrics = calculateLogMetrics({
      startMs: 1000,
      endMs: 1500,
      model: "unknown-model",
      usage: {
        input_tokens: 100,
        output_tokens: 0,
      },
      pricingCatalog: catalog,
    });

    expect(metrics.durationMs).toBe(500);
    expect(metrics.tokensPerSecond).toBe(0);
    expect(metrics.costUsd).toBe(0);
  });
});
