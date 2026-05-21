import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCfPathBlock,
  resetCfPathBlock,
  peekCfPathBlock,
  _resetAllCfPathBlocks,
} from "@src/auth/cf-path-block-tracker.js";

describe("cf-path-block-tracker", () => {
  beforeEach(() => {
    _resetAllCfPathBlocks();
  });

  it("increments per entry independently", () => {
    expect(recordCfPathBlock("a")).toBe(1);
    expect(recordCfPathBlock("a")).toBe(2);
    expect(recordCfPathBlock("b")).toBe(1);
    expect(recordCfPathBlock("a")).toBe(3);
  });

  it("resets after sliding window expires", () => {
    const t0 = 1_000_000;
    const t1 = t0 + 1000;
    expect(recordCfPathBlock("a", t0)).toBe(1);
    expect(recordCfPathBlock("a", t1)).toBe(2);
    // The window is measured from the most recent increment (t1).
    expect(recordCfPathBlock("a", t1 + 60 * 60 * 1000 + 1)).toBe(1);
  });

  it("resetCfPathBlock clears the counter", () => {
    recordCfPathBlock("a");
    recordCfPathBlock("a");
    resetCfPathBlock("a");
    expect(peekCfPathBlock("a")).toBe(0);
    expect(recordCfPathBlock("a")).toBe(1);
  });

  it("peek returns 0 for unknown entry and stale entry", () => {
    expect(peekCfPathBlock("ghost")).toBe(0);
    const t0 = 1_000_000;
    recordCfPathBlock("a", t0);
    expect(peekCfPathBlock("a", t0)).toBe(1);
    expect(peekCfPathBlock("a", t0 + 60 * 60 * 1000 + 1)).toBe(0);
  });
});
