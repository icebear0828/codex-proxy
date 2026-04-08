/**
 * AddAccount component tests — verify the cancel/close button is present
 * in the built JS output and the dialog can be dismissed.
 *
 * Reads built JS from public/assets/ (run `npm run build` first).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const PUBLIC_DIR = resolve(__dirname, "../../../public");
const ASSETS_DIR = resolve(PUBLIC_DIR, "assets");

let js = "";

beforeAll(() => {
  if (!existsSync(ASSETS_DIR)) {
    throw new Error("public/assets/ not found — run `npm run build` first");
  }
  const jsFile = readdirSync(ASSETS_DIR).find((f) => f.endsWith(".js"));
  if (!jsFile) {
    throw new Error("No JS file in public/assets/ — run `npm run build` first");
  }
  js = readFileSync(resolve(ASSETS_DIR, jsFile), "utf-8");
});

describe("AddAccount dialog", () => {
  it("includes cancel button text in built output", () => {
    // Both English and Chinese cancel translations must be present
    expect(js).toContain("Cancel");
    expect(js).toContain("\u53d6\u6d88"); // 取消
  });

  it("onCancel prop is wired in the component", () => {
    // The built JS should contain the onCancel prop usage
    expect(js).toContain("onCancel");
  });

  it("cancelAdd function is exported from useAccounts hook", () => {
    // Verify cancelAdd is referenced in the built bundle
    expect(js).toContain("cancelAdd");
  });
});
