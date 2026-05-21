import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ErrorsPage", () => {
  it("renders grouped sample_context in the expanded diagnostics panel", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/pages/ErrorsPage.tsx"),
      "utf-8",
    );

    expect(source).toContain("group.sample_context");
    expect(source).toContain("JSON.stringify(group.sample_context, null, 2)");
  });

  it("wires a clear-all control for persisted error log entries", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/pages/ErrorsPage.tsx"),
      "utf-8",
    );

    expect(source).toContain("clearAll");
    expect(source).toContain("errorsClear");
    expect(source).toContain("aria-label={t(\"errorsClear\")}");
    expect(source).toContain("onClick={() => void clearAll()}");
  });
});
