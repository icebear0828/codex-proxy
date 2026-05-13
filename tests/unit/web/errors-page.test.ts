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
});
