import { describe, it, expect, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: vi.fn(),
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useRef: vi.fn(),
}));

import { normalizeLogsQueryState } from "./use-logs.js";

describe("normalizeLogsQueryState", () => {
  it("resets page and clears selection when filters change", () => {
    const next = normalizeLogsQueryState(
      { direction: "all", search: "", page: 3, selected: { id: "1" } },
      { direction: "egress" },
    );

    expect(next.direction).toBe("egress");
    expect(next.page).toBe(0);
    expect(next.selected).toBeNull();
  });

  it("keeps page for pagination changes but clears selection", () => {
    const next = normalizeLogsQueryState(
      { direction: "all", search: "abc", page: 1, selected: { id: "1" } },
      { page: 2 },
    );

    expect(next.search).toBe("abc");
    expect(next.page).toBe(2);
    expect(next.selected).toBeNull();
  });

  it("preserves selection when query state is unchanged", () => {
    const selected = { id: "1" };
    const next = normalizeLogsQueryState(
      { direction: "all", search: "abc", page: 1, selected },
      {},
    );

    expect(next.page).toBe(1);
    expect(next.selected).toBe(selected);
  });
});
