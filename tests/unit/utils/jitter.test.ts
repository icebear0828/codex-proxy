import { describe, it, expect } from "vitest";
import { jitter, jitterInt } from "@src/utils/jitter.js";

describe("jitter", () => {
  it("returns a value within [base*(1-variance), base*(1+variance)]", () => {
    for (let i = 0; i < 1000; i++) {
      const result = jitter(100);
      expect(result).toBeGreaterThanOrEqual(80);
      expect(result).toBeLessThanOrEqual(120);
    }
  });

  it("accepts custom variance", () => {
    for (let i = 0; i < 1000; i++) {
      const result = jitter(100, 0.5);
      expect(result).toBeGreaterThanOrEqual(50);
      expect(result).toBeLessThanOrEqual(150);
    }
  });

  it("returns 0 for base 0", () => {
    expect(jitter(0)).toBe(0);
  });

  it("handles zero variance", () => {
    expect(jitter(100, 0)).toBe(100);
  });
});

describe("jitterInt", () => {
  it("returns an integer", () => {
    for (let i = 0; i < 100; i++) {
      const result = jitterInt(100);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it("returns a value within expected range", () => {
    for (let i = 0; i < 1000; i++) {
      const result = jitterInt(100);
      expect(result).toBeGreaterThanOrEqual(80);
      expect(result).toBeLessThanOrEqual(120);
    }
  });
});
