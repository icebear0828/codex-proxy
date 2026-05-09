import { describe, it, expect } from "vitest";
import { formatHitRate, formatUsageNumber, sumUsageWindow, sumWindow } from "../usage-stats";
import type { UsageDataPoint } from "../../hooks/use-usage-stats";

const point = (overrides: Partial<UsageDataPoint> = {}): UsageDataPoint => ({
  timestamp: "2026-05-03T20:00:00.000Z",
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  image_input_tokens: 0,
  image_output_tokens: 0,
  image_request_count: 0,
  image_request_failed_count: 0,
  request_count: 0,
  ...overrides,
});

describe("formatHitRate", () => {
  it("returns em dash when input is zero", () => {
    expect(formatHitRate(0, 0)).toBe("—");
    expect(formatHitRate(123, 0)).toBe("—");
  });

  it("returns 0% when nothing cached", () => {
    expect(formatHitRate(0, 1000)).toBe("0%");
  });

  it("formats sub-1% with two decimals", () => {
    expect(formatHitRate(5, 10000)).toBe("0.05%");
  });

  it("clamps very low values to <0.01%", () => {
    expect(formatHitRate(1, 10_000_000)).toBe("<0.01%");
  });

  it("formats normal values with one decimal", () => {
    expect(formatHitRate(390, 1000)).toBe("39.0%");
  });
});

describe("formatUsageNumber", () => {
  it("compacts thousands and millions with uppercase suffix", () => {
    expect(formatUsageNumber(999)).toBe("999");
    expect(formatUsageNumber(1500)).toBe("1.5K");
    expect(formatUsageNumber(2_500_000)).toBe("2.5M");
  });
});

describe("sumWindow", () => {
  it("sums cached and input across points", () => {
    const r = sumWindow([
      point({ input_tokens: 1000, cached_tokens: 200 }),
      point({ input_tokens: 4000, cached_tokens: 1000 }),
    ]);
    expect(r).toEqual({ cached: 1200, input: 5000 });
  });

  it("returns zeros for empty input", () => {
    expect(sumWindow([])).toEqual({ cached: 0, input: 0 });
  });
});

describe("sumUsageWindow", () => {
  it("sums every usage metric across points", () => {
    const r = sumUsageWindow([
      point({
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 300,
        image_input_tokens: 10,
        image_output_tokens: 20,
        image_request_count: 1,
        image_request_failed_count: 0,
        request_count: 2,
      }),
      point({
        input_tokens: 2000,
        output_tokens: 500,
        cached_tokens: 900,
        image_input_tokens: 30,
        image_output_tokens: 40,
        image_request_count: 2,
        image_request_failed_count: 1,
        request_count: 5,
      }),
    ]);

    expect(r).toEqual({
      input_tokens: 3000,
      output_tokens: 700,
      cached_tokens: 1200,
      image_input_tokens: 40,
      image_output_tokens: 60,
      image_request_count: 3,
      image_request_failed_count: 1,
      request_count: 7,
    });
  });
});
