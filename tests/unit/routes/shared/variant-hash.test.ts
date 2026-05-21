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

  it("changes when optional variant identity changes", () => {
    const tools = [{ type: "function", name: "read_file" }];
    expect(computeVariantHash("system", tools, "anchor-a")).not.toBe(
      computeVariantHash("system", tools, "anchor-b"),
    );
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

  it("freeze contract: tool array order matters — reordering same set yields a different hash", () => {
    // 设计契约（不是 bug）：variantHash 字节级敏感。Upstream prompt cache
    // 也字节级敏感（prefix 一变即 miss），所以 tool 顺序变化本来就该被视作
    // 不同 variant。如果未来翻译层（anthropic-to-codex 等）引入非确定性的 tool
    // 顺序（比如 `Object.values` over a `Map`），这条会立刻挂，提示要么稳住
    // 翻译层输出顺序，要么在 computeVariantHash 内部做 canonicalize。
    const a = [
      { type: "function", name: "read_file" },
      { type: "function", name: "write_file" },
    ];
    const b = [
      { type: "function", name: "write_file" },
      { type: "function", name: "read_file" },
    ];
    expect(computeVariantHash("system", a)).not.toBe(computeVariantHash("system", b));
  });

  it("freeze contract: per-tool field order matters — same key set in different order yields a different hash", () => {
    // 同上：tool 对象内 key 顺序变化也算不同 variant。这是 JSON.stringify 的
    // 自然语义（按 key 插入顺序输出），翻译层必须保证 key 顺序稳定。
    const a = [{ type: "function", name: "read_file" }];
    const b = [{ name: "read_file", type: "function" }];
    expect(computeVariantHash("system", a)).not.toBe(computeVariantHash("system", b));
  });
});
