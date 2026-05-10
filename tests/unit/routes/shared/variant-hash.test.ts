import { describe, it, expect } from "vitest";
import { computeVariantHash } from "@src/routes/shared/variant-hash.js";

describe("computeVariantHash", () => {
  it("returns the same hash for identical inputs", () => {
    const tools = [{ type: "function", name: "read_file" }];
    expect(computeVariantHash("system A", tools)).toBe(
      computeVariantHash("system A", tools),
    );
  });

  it("emits a 12-char hex digest", () => {
    const hash = computeVariantHash("system", [{ type: "function", name: "x" }]);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles empty / null instructions and tools without throwing", () => {
    expect(() => computeVariantHash("", [])).not.toThrow();
    expect(() => computeVariantHash(null, null)).not.toThrow();
    expect(() => computeVariantHash(undefined, undefined)).not.toThrow();
    expect(computeVariantHash(null, null)).toBe(computeVariantHash("", []));
  });

  it("changes when instructions change by a single byte", () => {
    const tools = [{ type: "function", name: "read_file" }];
    expect(computeVariantHash("system A", tools)).not.toBe(
      computeVariantHash("system B", tools),
    );
  });

  it("changes when tools schema changes", () => {
    const a = computeVariantHash("system", [
      { type: "function", name: "read_file" },
    ]);
    const b = computeVariantHash("system", [
      { type: "function", name: "read_file", description: "added" },
    ]);
    expect(a).not.toBe(b);
  });

  it("differentiates subagent footprints (real-world: instr=34391B/tools=27 vs instr=10185B/tools=19)", () => {
    const mainTools = Array.from({ length: 27 }, (_, i) => ({
      type: "function",
      name: `tool_${i}`,
    }));
    const subagentTools = Array.from({ length: 19 }, (_, i) => ({
      type: "function",
      name: `sub_${i}`,
    }));
    const mainInstr = "x".repeat(34391);
    const subagentInstr = "y".repeat(10185);

    expect(computeVariantHash(mainInstr, mainTools)).not.toBe(
      computeVariantHash(subagentInstr, subagentTools),
    );
  });

  it("collapses to the same hash across turns when instructions+tools are byte-stable", () => {
    // 主对话的多轮：input 在变（messages 累加），但 instructions 和 tools 不变。
    // variantHash 必须稳定，否则同一 conv 内每轮都被路由到不同 pool slot。
    const instr = "stable system";
    const tools = [{ type: "function", name: "read_file" }];
    expect(computeVariantHash(instr, tools)).toBe(computeVariantHash(instr, tools));
  });
});
