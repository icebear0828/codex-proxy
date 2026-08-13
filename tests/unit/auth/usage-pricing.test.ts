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

  it("requires all pricing fields to be finite and non-negative", () => {
    const invalid: Record<string, ModelPricing> = {
      invalid: { input_usd_per_million: -1, cached_input_usd_per_million: 0, output_usd_per_million: 1 },
    };
    expect(() => createPricingCatalog(invalid)).toThrow(/non-negative/);
  });
});
