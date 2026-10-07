import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { calculateLogMetrics, resetPricingCatalogCache } from "../../../src/logs/metrics.js";
import {
  createPricingCatalog,
  loadPricingCatalog,
  resetPricingLoadWarnings,
} from "../../../src/auth/usage-pricing.js";

vi.mock("../../../src/auth/usage-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/usage-pricing.js")>();
  return { ...actual, loadPricingCatalog: vi.fn(actual.loadPricingCatalog) };
});

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

describe("pricing catalog diagnostics (#837)", () => {
  const usage = { input_tokens: 1000, output_tokens: 10 };
  const realCatalog = createPricingCatalog({
    "gpt-5.5": {
      input_usd_per_million: 3.0,
      cached_input_usd_per_million: 0.75,
      output_usd_per_million: 15.0,
    },
  });
  const mockedLoad = vi.mocked(loadPricingCatalog);
  let warnSpy: MockInstance;
  let infoSpy: MockInstance;

  const missingPricingError = () =>
    new Error("ENOENT: no such file or directory, open '/app/config/model-pricing.yaml'");

  function pricingWarnings(): string[] {
    return warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("[pricing]"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetPricingCatalogCache();
    resetPricingLoadWarnings();
    mockedLoad.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("warns once with the file path when the catalog is missing, and still reports zero cost", () => {
    mockedLoad.mockImplementation(() => {
      throw missingPricingError();
    });

    const metrics = calculateLogMetrics({ startMs: 0, endMs: 1000, model: "gpt-5.5", usage });

    expect(metrics.costUsd).toBe(0);
    expect(pricingWarnings()).toHaveLength(1);
    expect(pricingWarnings()[0]).toContain("model-pricing.yaml");
  });

  it("does not re-read within the retry cooldown, then retries and recovers without a restart", () => {
    mockedLoad.mockImplementation(() => {
      throw missingPricingError();
    });

    calculateLogMetrics({ startMs: 0, endMs: 1000, model: "gpt-5.5", usage });
    expect(mockedLoad).toHaveBeenCalledTimes(1);

    // Still failing and still inside the cooldown: no new read, no new warning.
    calculateLogMetrics({ startMs: 0, endMs: 1000, model: "gpt-5.5", usage });
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(pricingWarnings()).toHaveLength(1);

    // The operator drops the missing file into the config volume; the first
    // attempt after the cooldown picks it up without a process restart.
    vi.setSystemTime(Date.now() + 61_000);
    mockedLoad.mockImplementation(() => realCatalog);
    const recovered = calculateLogMetrics({ startMs: 0, endMs: 1000, model: "gpt-5.5", usage });

    expect(mockedLoad).toHaveBeenCalledTimes(2);
    expect(recovered.costUsd).toBeGreaterThan(0);
    expect(infoSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("[pricing]");

    // Once loaded, the catalog is cached again — no further reads.
    calculateLogMetrics({ startMs: 0, endMs: 1000, model: "gpt-5.5", usage });
    expect(mockedLoad).toHaveBeenCalledTimes(2);
  });
});
