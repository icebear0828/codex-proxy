import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..");

function script(name: string): string {
  return readFileSync(resolve(ROOT, "scripts", "build", name), "utf-8");
}

describe("update scripts path resolution", () => {
  it("resolves repository root from scripts/build", () => {
    for (const name of ["check-update.ts", "full-update.ts", "apply-update.ts", "extract-fingerprint.ts"]) {
      expect(script(name), name).toContain('const ROOT = resolve(import.meta.dirname, "..", "..");');
    }
  });

  it("imports root src utilities from apply-update", () => {
    expect(script("apply-update.ts")).toContain('from "../../src/utils/yaml-mutate.js"');
    expect(script("apply-update.ts")).not.toContain('from "../src/utils/yaml-mutate.js"');
  });
});
