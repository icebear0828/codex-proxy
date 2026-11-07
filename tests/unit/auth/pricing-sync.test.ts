import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  convertLiteLlmPricing,
  convertOpenRouterPricing,
  mergePricingCatalogs,
  pricingTableURLs,
  fetchRemotePricingCatalog,
  startPricingSyncScheduler,
  isOfficialModel,
} from "@src/auth/pricing-sync.js";
import {
  loadPricingCatalog,
  setDynamicPricingCatalog,
  resetDynamicPricingCatalog,
  calculateUsageCostUsd,
} from "@src/auth/usage-pricing.js";

describe("pricing sync - conversion", () => {
  it("converts standard LiteLLM models to project ModelPricing format", () => {
    const rawLiteLlm = {
      sample_spec: {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
        mode: "one of: chat",
      },
      "gpt-5": {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125,
      },
      "gpt-image-2": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0,
        cache_read_input_token_cost: 0.00000125,
        input_cost_per_image_token: 0.000008,
        output_cost_per_image_token: 0.00003,
      },
    };

    const converted = convertLiteLlmPricing(rawLiteLlm);
    expect(converted["gpt-5"]).toEqual({
      input_usd_per_million: 1.25,
      cached_input_usd_per_million: 0.125,
      output_usd_per_million: 10,
    });
    expect(converted["gpt-image-2"]).toEqual({
      input_usd_per_million: 5,
      cached_input_usd_per_million: 1.25,
      output_usd_per_million: 0,
      image_input_usd_per_million: 8,
      image_output_usd_per_million: 30,
    });
    expect(converted["sample_spec"]).toBeUndefined();
  });

  it("handles models with provider prefixes by registering both prefix and base id", () => {
    const raw = {
      "openai/gpt-4o": {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.00000125,
      },
    };
    const converted = convertLiteLlmPricing(raw);
    expect(converted["openai/gpt-4o"]).toBeDefined();
    expect(converted["gpt-4o"]).toBeDefined();
    expect(converted["gpt-4o"]?.input_usd_per_million).toBe(2.5);
  });

  it("defaults cached_input_usd_per_million to input_usd_per_million if uncached", () => {
    const raw = {
      "gpt-4-turbo": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    };
    const converted = convertLiteLlmPricing(raw);
    expect(converted["gpt-4-turbo"]).toEqual({
      input_usd_per_million: 3,
      cached_input_usd_per_million: 3,
      output_usd_per_million: 15,
    });
  });

  it("filters out non-official models and third-party cloud wrappers in convertLiteLlmPricing", () => {
    const raw = {
      "azure/gpt-6.1-sol": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
      },
      "bedrock/anthropic.claude-3-sonnet": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      "ALIA-40b-instruct_Q8_0": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000001,
      },
      "openai/gpt-4o": {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
      },
    };
    const converted = convertLiteLlmPricing(raw);
    expect(converted["azure/gpt-6.1-sol"]).toBeUndefined();
    expect(converted["gpt-6.1-sol"]).toBeUndefined();
    expect(converted["bedrock/anthropic.claude-3-sonnet"]).toBeUndefined();
    expect(converted["ALIA-40b-instruct_Q8_0"]).toBeUndefined();
    expect(converted["openai/gpt-4o"]).toBeDefined();
    expect(converted["gpt-4o"]).toBeDefined();
  });

  it("converts OpenRouter models to ModelPricing format", () => {
    const rawOpenRouter = {
      data: [
        {
          id: "anthropic/claude-3.5-sonnet",
          pricing: {
            prompt: "0.000003",
            completion: "0.000015",
          },
        },
      ],
    };
    const converted = convertOpenRouterPricing(rawOpenRouter);
    expect(converted["anthropic/claude-3.5-sonnet"]).toBeDefined();
    expect(converted["claude-3.5-sonnet"]).toBeDefined();
    expect(converted["claude-3.5-sonnet"]?.input_usd_per_million).toBe(3);
    expect(converted["claude-3.5-sonnet"]?.output_usd_per_million).toBe(15);
  });

  it("merges pricing catalogs, preserving unique entries from earlier catalogs", () => {
    const local = {
      "gpt-reserve": {
        input_usd_per_million: 0.2,
        cached_input_usd_per_million: 0.02,
        output_usd_per_million: 1.2,
      },
      "gpt-5": {
        input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 8,
      },
    };
    const upstream = {
      "gpt-5": {
        input_usd_per_million: 1.25,
        cached_input_usd_per_million: 0.125,
        output_usd_per_million: 10,
      },
      "gpt-6-astra": {
        input_usd_per_million: 10,
        cached_input_usd_per_million: 1,
        output_usd_per_million: 50,
      },
    };
    const merged = mergePricingCatalogs(local, upstream);
    expect(merged["gpt-reserve"]).toEqual(local["gpt-reserve"]);
    expect(merged["gpt-5"]).toEqual(upstream["gpt-5"]);
    expect(merged["gpt-6-astra"]).toEqual(upstream["gpt-6-astra"]);
  });
});

describe("pricing sync - pricingTableURLs & multi-source dynamic pull", () => {
  const tmpDir = join(process.cwd(), "data", "__test_pricing_sync__");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    resetDynamicPricingCatalog();
  });

  afterEach(() => {
    resetDynamicPricingCatalog();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("defines default pricingTableURLs containing CDN and raw GitHub fallback", () => {
    expect(pricingTableURLs.length).toBeGreaterThanOrEqual(2);
    expect(pricingTableURLs.some((u) => u.includes("jsdelivr"))).toBe(true);
    expect(pricingTableURLs.some((u) => u.includes("raw.githubusercontent.com"))).toBe(true);
  });

  it("fetches from the first available URL in pricingTableURLs", async () => {
    const fakeCatalog = {
      models: {
        "gpt-dyn": {
          input_usd_per_million: 1.5,
          cached_input_usd_per_million: 0.15,
          output_usd_per_million: 6.0,
        },
      },
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeCatalog,
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchRemotePricingCatalog({
      urls: ["https://cdn.example.com/pricing.json"],
      dataDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result?.["gpt-dyn"]?.input_usd_per_million).toBe(1.5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify usage calculation uses dynamic catalog
    const cost = calculateUsageCostUsd("gpt-dyn", { input_tokens: 1_000_000, output_tokens: 0 }, result!);
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it("falls back to secondary URL if primary mirror fails", async () => {
    const fakeCatalog = {
      models: {
        "gpt-dyn-fallback": {
          input_usd_per_million: 2.0,
          cached_input_usd_per_million: 0.2,
          output_usd_per_million: 8.0,
        },
      },
    };

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error("Network connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCatalog,
      });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchRemotePricingCatalog({
      urls: [
        "https://broken-primary.example.com/pricing.json",
        "https://working-cdn.example.com/pricing.json",
      ],
      dataDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result?.["gpt-dyn-fallback"]?.output_usd_per_million).toBe(8.0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("supports directly parsing LiteLLM format from remote URL", async () => {
    const rawLiteLlm = {
      "claude-dyn": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => rawLiteLlm,
    }));

    const result = await fetchRemotePricingCatalog({
      urls: ["https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json"],
      dataDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result?.["claude-dyn"]?.input_usd_per_million).toBe(3);
    expect(result?.["claude-dyn"]?.output_usd_per_million).toBe(15);
  });

  it("returns null when all URLs fail without throwing unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DNS failure")));

    const result = await fetchRemotePricingCatalog({
      urls: ["https://url1.example.com", "https://url2.example.com"],
      dataDir: tmpDir,
    });

    expect(result).toBeNull();
  });

  it("loads model-pricing.json from configDir when present", () => {
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "model-pricing.json"),
      JSON.stringify({
        models: {
          "gpt-json": {
            input_usd_per_million: 1.0,
            cached_input_usd_per_million: 0.1,
            output_usd_per_million: 2.0,
          },
        },
      }),
      "utf8",
    );

    const catalog = loadPricingCatalog(configDir);
    expect(catalog["gpt-json"]).toBeDefined();
    expect(catalog["gpt-json"]?.input_usd_per_million).toBe(1.0);
  });

  it("startPricingSyncScheduler schedules periodic fetch and stop cleanly", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: {} }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const stop = startPricingSyncScheduler({
      intervalMs: 10_000,
      urls: ["https://example.com/pricing.json"],
    });

    expect(typeof stop).toBe("function");
    vi.advanceTimersByTime(11_000);
    expect(fetchSpy).toHaveBeenCalled();

    stop();
    vi.advanceTimersByTime(20_000);
    vi.useRealTimers();
  });

  it("aborts in-flight fetch when abort signal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchRemotePricingCatalog({
      urls: ["https://example.com/pricing.json"],
      dataDir: tmpDir,
      signal: controller.signal,
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ensures local catalog overrides dynamic remote pricing for identical model keys", () => {
    // Dynamic catalog sets gpt-6.1-sol to low price
    setDynamicPricingCatalog({
      "gpt-6.1-sol": {
        input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 2,
      },
      "claude-remote-only": {
        input_usd_per_million: 3,
        cached_input_usd_per_million: 0.3,
        output_usd_per_million: 15,
      },
    });

    // Default loadPricingCatalog loads local config/model-pricing.yaml merged with dynamic
    const merged = loadPricingCatalog();

    // Local model-pricing.yaml has gpt-6.1-sol = 5 / 0.5 / 30
    expect(merged["gpt-6.1-sol"]?.input_usd_per_million).toBe(5);
    expect(merged["gpt-6.1-sol"]?.output_usd_per_million).toBe(30);

    // Remote-only model is preserved
    expect(merged["claude-remote-only"]?.input_usd_per_million).toBe(3);
  });
});

describe("pricing sync - isOfficialModel filter", () => {
  it("allows official OpenAI models and prefixes", () => {
    expect(isOfficialModel("openai/gpt-4o")).toBe(true);
    expect(isOfficialModel("gpt-4o")).toBe(true);
    expect(isOfficialModel("gpt-5.5")).toBe(true);
    expect(isOfficialModel("gpt-image-2")).toBe(true);
    expect(isOfficialModel("o1-preview")).toBe(true);
    expect(isOfficialModel("o3-mini")).toBe(true);
  });

  it("allows official Anthropic, Google, and DeepSeek models", () => {
    expect(isOfficialModel("anthropic/claude-3-5-sonnet")).toBe(true);
    expect(isOfficialModel("claude-3-5-sonnet-20241022")).toBe(true);
    expect(isOfficialModel("google/gemini-2.5-flash")).toBe(true);
    expect(isOfficialModel("gemini-2.5-flash")).toBe(true);
    expect(isOfficialModel("deepseek/deepseek-chat")).toBe(true);
    expect(isOfficialModel("deepseek-chat")).toBe(true);
    expect(isOfficialModel("deepseek-r1")).toBe(true);
  });

  it("rejects third-party cloud wrappers, proxies, and unrelated models", () => {
    expect(isOfficialModel("azure/gpt-6.1-sol")).toBe(false);
    expect(isOfficialModel("azure_ai/gpt-4o")).toBe(false);
    expect(isOfficialModel("bedrock/anthropic.claude-3-sonnet")).toBe(false);
    expect(isOfficialModel("zerogpu/gpt-4.1-mini")).toBe(false);
    expect(isOfficialModel("Beam-1.0-501B-A23B")).toBe(false);
    expect(isOfficialModel("ALIA-40b-instruct_Q8_0")).toBe(false);
    expect(isOfficialModel("openrouter/auto")).toBe(false);
    expect(isOfficialModel("random-model")).toBe(false);
  });
});
