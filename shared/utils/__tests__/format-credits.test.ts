import { describe, it, expect } from "vitest";
import { formatCredits, creditsToUsd, formatUsd } from "../format";

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
