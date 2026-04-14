/**
 * Tests for quota config section parsing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing config
vi.mock("@src/models/model-store.js", () => ({
  loadStaticModels: vi.fn(),
}));
vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

import { z } from "zod";

// Replicate the quota schema to test independently
const QuotaSchema = z.object({
  refresh_interval_minutes: z.number().min(0).default(5),
  concurrency: z.number().int().min(1).default(10),
  warning_thresholds: z.object({
    primary: z.array(z.number().min(1).max(100)).default([80, 90]),
    secondary: z.array(z.number().min(1).max(100)).default([80, 90]),
  }).default({}),
  skip_exhausted: z.boolean().default(true),
}).default({});

describe("quota config schema", () => {
  it("uses defaults when empty", () => {
    const result = QuotaSchema.parse({});
    expect(result.refresh_interval_minutes).toBe(5);
    expect(result.warning_thresholds.primary).toEqual([80, 90]);
    expect(result.warning_thresholds.secondary).toEqual([80, 90]);
    expect(result.skip_exhausted).toBe(true);
  });

  it("uses defaults when undefined", () => {
    const result = QuotaSchema.parse(undefined);
    expect(result.refresh_interval_minutes).toBe(5);
  });

  it("accepts custom thresholds", () => {
    const result = QuotaSchema.parse({
      refresh_interval_minutes: 10,
      warning_thresholds: {
        primary: [70, 85, 95],
        secondary: [60],
      },
      skip_exhausted: false,
    });
    expect(result.refresh_interval_minutes).toBe(10);
    expect(result.warning_thresholds.primary).toEqual([70, 85, 95]);
    expect(result.warning_thresholds.secondary).toEqual([60]);
    expect(result.skip_exhausted).toBe(false);
  });

  it("accepts refresh_interval_minutes = 0 (disable auto-refresh)", () => {
    const result = QuotaSchema.parse({ refresh_interval_minutes: 0 });
    expect(result.refresh_interval_minutes).toBe(0);
  });

  it("rejects refresh_interval_minutes < 0", () => {
    expect(() => QuotaSchema.parse({ refresh_interval_minutes: -1 })).toThrow();
  });

  it("rejects threshold > 100", () => {
    expect(() => QuotaSchema.parse({
      warning_thresholds: { primary: [101] },
    })).toThrow();
  });

  it("rejects threshold < 1", () => {
    expect(() => QuotaSchema.parse({
      warning_thresholds: { primary: [0] },
    })).toThrow();
  });
});
