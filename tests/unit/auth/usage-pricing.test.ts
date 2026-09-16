import { describe, expect, it } from "vitest";
import {
  calculateUsageCostUsd,
  createPricingCatalog,
  type ModelPricing,
} from "@src/auth/usage-pricing.js";

describe("usage pricing", () => {
  const catalog = createPricingCatalog({
    "gpt-test": {
      input_usd_per_million: 2,
      cached_input_usd_per_million: 0.2,
      output_usd_per_million: 8,
    },
  });

  it("calculates input, cached input, and output at the configured rates", () => {
    expect(calculateUsageCostUsd("gpt-test", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cached_tokens: 250_000,
    }, catalog)).toBeCloseTo(5.55, 10);
  });

  it("does not double-charge cached input tokens", () => {
    expect(calculateUsageCostUsd("gpt-test", {
      input_tokens: 100,
      output_tokens: 0,
      cached_tokens: 100,
    }, catalog)).toBeCloseTo(0.00002, 10);
  });

  it("matches model suffixes and returns zero for unknown models", () => {
    expect(calculateUsageCostUsd("gpt-test-high", { input_tokens: 1_000_000, output_tokens: 0 }, catalog)).toBe(2);
    expect(calculateUsageCostUsd("not-in-catalog", { input_tokens: 1_000_000, output_tokens: 1_000_000 }, catalog)).toBe(0);
  });

  it("resolves -max and -ultra reasoning tiers to the base model pricing", () => {
    const tierCatalog = createPricingCatalog({
      "gpt-test": {
        input_usd_per_million: 2,
        cached_input_usd_per_million: 0.2,
        output_usd_per_million: 8,
      },
    });
    expect(calculateUsageCostUsd("gpt-test-max", { input_tokens: 1_000_000, output_tokens: 0 }, tierCatalog)).toBe(2);
    expect(calculateUsageCostUsd("gpt-test-ultra", { input_tokens: 1_000_000, output_tokens: 0 }, tierCatalog)).toBe(2);
  });

  it("matches bare model names for custom upstream requests", () => {
    const bareCatalog = createPricingCatalog({
      "gpt-6": {
        input_usd_per_million: 10,
        cached_input_usd_per_million: 1,
        output_usd_per_million: 50,
      },
      "gpt-6-astra": {
        input_usd_per_million: 10,
        cached_input_usd_per_million: 1,
        output_usd_per_million: 50,
      },
    });
    expect(calculateUsageCostUsd("gpt-6", { input_tokens: 1_000_000, output_tokens: 1_000_000 }, bareCatalog)).toBeCloseTo(60, 10);
    expect(calculateUsageCostUsd("gpt-6-astra-max", { input_tokens: 1_000_000, output_tokens: 0 }, bareCatalog)).toBe(10);
    expect(calculateUsageCostUsd("gpt-6-astra-ultra", { input_tokens: 1_000_000, output_tokens: 0 }, bareCatalog)).toBe(10);
  });

  it("calculates image generation tokens using default image pricing when host model has no image pricing", () => {
    const multiCatalog = createPricingCatalog({
      "gpt-test": {
        input_usd_per_million: 2,
        cached_input_usd_per_million: 0.2,
        output_usd_per_million: 8,
      },
      "gpt-image-2": {
        input_usd_per_million: 5,
        cached_input_usd_per_million: 1.25,
        output_usd_per_million: 0,
        image_input_usd_per_million: 8,
        image_output_usd_per_million: 30,
      },
    });

    expect(calculateUsageCostUsd("gpt-test", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      image_input_tokens: 100_000,
      image_output_tokens: 50_000,
    }, multiCatalog)).toBeCloseTo(8.3, 10);
  });

  it("uses model-specific image pricing when defined on the model", () => {
    const customCatalog = createPricingCatalog({
      "gpt-custom": {
        input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 2,
        image_input_usd_per_million: 4,
        image_output_usd_per_million: 10,
      },
      "gpt-image-2": {
        input_usd_per_million: 5,
        cached_input_usd_per_million: 1.25,
        output_usd_per_million: 0,
        image_input_usd_per_million: 8,
        image_output_usd_per_million: 30,
      },
    });

    expect(calculateUsageCostUsd("gpt-custom", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      image_input_tokens: 100_000,
      image_output_tokens: 50_000,
    }, customCatalog)).toBeCloseTo(2.9, 10);
  });

  it("requires all pricing fields to be finite and non-negative", () => {
    const invalid: Record<string, ModelPricing> = {
      invalid: { input_usd_per_million: -1, cached_input_usd_per_million: 0, output_usd_per_million: 1 },
    };
    expect(() => createPricingCatalog(invalid)).toThrow(/non-negative/);
  });
});
