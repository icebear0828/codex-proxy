import { describe, it, expect } from "vitest";
import { formatTruncatedUsd, formatCredits, creditsToUsd, formatUsd, formatWindowDuration, formatResetTime } from "../format";

describe("formatCredits", () => {
  it("renders zero as plain '0'", () => {
    expect(formatCredits(0)).toBe("0");
  });

  it("strips trailing zeros for round numbers", () => {
    expect(formatCredits(5)).toBe("5");
    expect(formatCredits(247.5)).toBe("247.5");
  });

  it("rounds small decimals to two places", () => {
    expect(formatCredits(12.345)).toBe("12.35");
    expect(formatCredits(0.05)).toBe("0.05");
  });

  it("uses k suffix above 1000", () => {
    expect(formatCredits(3196)).toBe("3.2k");
    expect(formatCredits(7000)).toBe("7k");
  });

  it("returns '0' for non-finite input", () => {
    expect(formatCredits(NaN)).toBe("0");
    expect(formatCredits(Infinity)).toBe("0");
  });
});

describe("creditsToUsd", () => {
  it("converts at the default rate (25 credits = $1)", () => {
    expect(creditsToUsd(25, 25)).toBe(1);
    expect(creditsToUsd(1000, 25)).toBe(40);
  });

  it("returns null when rate is zero or negative (USD display disabled)", () => {
    expect(creditsToUsd(500, 0)).toBeNull();
    expect(creditsToUsd(500, -1)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(creditsToUsd(NaN, 25)).toBeNull();
    expect(creditsToUsd(100, NaN)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats with $ sign and two decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("uses k suffix above $1000", () => {
    expect(formatUsd(1234.56)).toBe("$1.2k");
    expect(formatUsd(40000)).toBe("$40k");
  });

  it("handles negatives", () => {
    expect(formatUsd(-12.34)).toBe("-$12.34");
  });
});

describe("formatTruncatedUsd", () => {
  it("truncates to two decimal places without rounding", () => {
    expect(formatTruncatedUsd(0.0064)).toBe("$0.00");
    expect(formatTruncatedUsd(745.659)).toBe("$745.65");
    expect(formatTruncatedUsd(3994.609)).toBe("$3994.60");
  });

  it("can omit the currency symbol for the total half of a paired value", () => {
    expect(formatTruncatedUsd(3994.609, false)).toBe("3994.60");
  });
});

describe("formatWindowDuration", () => {
  it("formats minutes, hours, days in English, Simplified Chinese, Traditional Chinese, and Japanese", () => {
    expect(formatWindowDuration(180, "en")).toBe("3m");
    expect(formatWindowDuration(180, "zh")).toBe("3分钟");
    expect(formatWindowDuration(180, "zh-TW")).toBe("3分鐘");
    expect(formatWindowDuration(180, "zh-HK")).toBe("3分鐘");
    expect(formatWindowDuration(180, "ja")).toBe("3分");

    expect(formatWindowDuration(18000, "en")).toBe("5h");
    expect(formatWindowDuration(18000, "zh")).toBe("5小时");
    expect(formatWindowDuration(18000, "zh-TW")).toBe("5小時");
    expect(formatWindowDuration(18000, "zh-HK")).toBe("5小時");
    expect(formatWindowDuration(18000, "ja")).toBe("5時間");

    expect(formatWindowDuration(86400 * 7, "en")).toBe("7d");
    expect(formatWindowDuration(86400 * 7, "zh")).toBe("7天");
    expect(formatWindowDuration(86400 * 7, "zh-TW")).toBe("7天");
    expect(formatWindowDuration(86400 * 7, "zh-HK")).toBe("7天");
    expect(formatWindowDuration(86400 * 7, "ja")).toBe("7日");
  });
});
