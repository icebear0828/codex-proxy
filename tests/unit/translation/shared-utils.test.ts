import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "Desktop context prompt content"),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      inject_desktop_context: true,
      suppress_desktop_directives: true,
    },
  })),
}));

import { budgetToEffort, buildInstructions } from "@src/translation/shared-utils.js";
import { getConfig } from "@src/config.js";

describe("budgetToEffort", () => {
  it("returns undefined for 0", () => {
    expect(budgetToEffort(0)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(budgetToEffort(undefined)).toBeUndefined();
  });

  it("returns undefined for negative", () => {
    expect(budgetToEffort(-100)).toBeUndefined();
  });

  it("returns 'low' for budget < 2000", () => {
    expect(budgetToEffort(1000)).toBe("low");
    expect(budgetToEffort(1999)).toBe("low");
  });

  it("returns 'medium' for budget < 8000", () => {
    expect(budgetToEffort(2000)).toBe("medium");
    expect(budgetToEffort(5000)).toBe("medium");
    expect(budgetToEffort(7999)).toBe("medium");
  });

  it("returns 'high' for budget < 20000", () => {
    expect(budgetToEffort(8000)).toBe("high");
    expect(budgetToEffort(15000)).toBe("high");
    expect(budgetToEffort(19999)).toBe("high");
  });

  it("returns 'xhigh' for budget >= 20000", () => {
    expect(budgetToEffort(20000)).toBe("xhigh");
    expect(budgetToEffort(25000)).toBe("xhigh");
  });
});

describe("buildInstructions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends suppress prompt when suppress_desktop_directives is true", async () => {
    // Re-import to get fresh cache
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("user instructions");
    expect(result).toContain("user instructions");
    // When desktop context is loaded and suppress is on, should contain suppress marker
    expect(result).toContain("NOT applicable");
  });

  it("returns string containing user instructions", async () => {
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("custom instructions");
    expect(result).toContain("custom instructions");
    expect(typeof result).toBe("string");
  });

  it("includes desktop context when available", async () => {
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("user text");
    // Desktop context is mocked as "Desktop context prompt content"
    expect(result).toContain("user text");
    expect(result).toContain("Desktop context");
  });
});

describe("budgetToEffort additional edge cases", () => {
  it("returns 'low' for budget = 1 (minimum positive)", () => {
    expect(budgetToEffort(1)).toBe("low");
  });

  it("returns undefined for budget = -1", () => {
    expect(budgetToEffort(-1)).toBeUndefined();
  });

  it("returns 'xhigh' for very large budget (100000)", () => {
    expect(budgetToEffort(100000)).toBe("xhigh");
  });
});
