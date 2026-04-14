import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateThresholds,
  updateWarnings,
  clearWarnings,
  getActiveWarnings,
  getWarningsLastUpdated,
} from "@src/auth/quota-warnings.js";

describe("evaluateThresholds", () => {
  it("returns null when usedPercent is null", () => {
    const result = evaluateThresholds("a1", "a@test.com", null, null, "primary", [80, 90]);
    expect(result).toBeNull();
  });

  it("returns null when below all thresholds", () => {
    const result = evaluateThresholds("a1", "a@test.com", 50, 1700000000, "primary", [80, 90]);
    expect(result).toBeNull();
  });

  it("returns warning when between thresholds", () => {
    const result = evaluateThresholds("a1", "a@test.com", 85, 1700000000, "primary", [80, 90]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("warning");
    expect(result!.usedPercent).toBe(85);
    expect(result!.window).toBe("primary");
  });

  it("returns critical when at or above highest threshold", () => {
    const result = evaluateThresholds("a1", "a@test.com", 95, 1700000000, "primary", [80, 90]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("critical");
    expect(result!.usedPercent).toBe(95);
  });

  it("returns critical when exactly at highest threshold", () => {
    const result = evaluateThresholds("a1", null, 90, null, "secondary", [80, 90]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("critical");
    expect(result!.email).toBeNull();
  });

  it("handles single threshold (always critical)", () => {
    const result = evaluateThresholds("a1", "a@test.com", 80, null, "primary", [80]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("critical");
  });

  it("handles unsorted thresholds", () => {
    const result = evaluateThresholds("a1", "a@test.com", 85, null, "primary", [90, 80]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("warning"); // 85 >= 80 but < 90
  });

  it("handles three thresholds", () => {
    // [60, 80, 90]: 75 should be warning (between 60 and 80)
    const result = evaluateThresholds("a1", null, 75, null, "primary", [60, 80, 90]);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("warning");
  });
});

describe("warning store", () => {
  beforeEach(() => {
    // Clear all warnings
    for (const w of getActiveWarnings()) {
      clearWarnings(w.accountId);
    }
  });

  it("starts empty", () => {
    expect(getActiveWarnings()).toEqual([]);
  });

  it("stores and retrieves warnings", () => {
    updateWarnings("a1", [
      { accountId: "a1", email: "a@test.com", window: "primary", level: "warning", usedPercent: 85, resetAt: null },
    ]);
    const all = getActiveWarnings();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe("a1");
    expect(getWarningsLastUpdated()).not.toBeNull();
  });

  it("replaces warnings for same account", () => {
    updateWarnings("a1", [
      { accountId: "a1", email: null, window: "primary", level: "warning", usedPercent: 85, resetAt: null },
    ]);
    updateWarnings("a1", [
      { accountId: "a1", email: null, window: "primary", level: "critical", usedPercent: 95, resetAt: null },
    ]);
    const all = getActiveWarnings();
    expect(all).toHaveLength(1);
    expect(all[0].level).toBe("critical");
  });

  it("clears warnings for account", () => {
    updateWarnings("a1", [
      { accountId: "a1", email: null, window: "primary", level: "warning", usedPercent: 85, resetAt: null },
    ]);
    updateWarnings("a2", [
      { accountId: "a2", email: null, window: "secondary", level: "critical", usedPercent: 95, resetAt: null },
    ]);
    clearWarnings("a1");
    const all = getActiveWarnings();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe("a2");
  });

  it("removes warnings when updated with empty array", () => {
    updateWarnings("a1", [
      { accountId: "a1", email: null, window: "primary", level: "warning", usedPercent: 85, resetAt: null },
    ]);
    updateWarnings("a1", []);
    expect(getActiveWarnings()).toHaveLength(0);
  });
});
