/**
 * Theme CSS tests — verify light/dark modes produce visually distinct styles.
 *
 * Reads the built CSS from public/assets/ (run `npm run build` first).
 * Verifies:
 *   1. CSS custom properties (--primary) differ between :root and .dark
 *   2. Tailwind dark: variants exist and require .dark ancestor
 *   3. Body element uses Tailwind dark: classes for bg/text
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const PUBLIC_DIR = resolve(__dirname, "../../../public");
const ASSETS_DIR = resolve(PUBLIC_DIR, "assets");

let css = "";
let html = "";

beforeAll(() => {
  if (!existsSync(ASSETS_DIR)) {
    throw new Error("public/assets/ not found — run `npm run build` first");
  }
  const cssFile = readdirSync(ASSETS_DIR).find((f) => f.endsWith(".css"));
  if (!cssFile) {
    throw new Error("No CSS file in public/assets/ — run `npm run build` first");
  }
  css = readFileSync(resolve(ASSETS_DIR, cssFile), "utf-8");
  html = readFileSync(resolve(PUBLIC_DIR, "index.html"), "utf-8");
});

/** Extract a CSS block by selector substring */
function findRule(selector: string): string | null {
  const blocks = css.split("}");
  const match = blocks.find((b) => b.includes(selector));
  return match ? match + "}" : null;
}

/** Extract CSS custom properties from a rule block */
function extractVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /--([\w-]+)\s*:\s*([^;]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    vars[`--${m[1]}`] = m[2].trim();
  }
  return vars;
}

function getRootVars(): Record<string, string> {
  return extractVars(findRule(":root{") ?? findRule(":root {") ?? "");
}

function getDarkVars(): Record<string, string> {
  return extractVars(findRule(".dark{") ?? findRule(".dark {") ?? "");
}

describe("Theme CSS", () => {
  describe("CSS custom properties — :root vs .dark", () => {
    it(":root defines --primary", () => {
      expect(getRootVars()["--primary"]).toBeDefined();
    });

    it(".dark defines --primary", () => {
      expect(getDarkVars()["--primary"]).toBeDefined();
    });

    it("--primary differs between :root and .dark", () => {
      expect(getRootVars()["--primary"]).not.toBe(getDarkVars()["--primary"]);
    });

    it("color-scheme: light in :root, dark in .dark", () => {
      const rootBlock = findRule(":root{") ?? findRule(":root {") ?? "";
      const darkBlock = findRule(".dark{") ?? findRule(".dark {") ?? "";
      expect(rootBlock).toContain("color-scheme:light");
      expect(darkBlock).toContain("color-scheme:dark");
    });
  });

  describe("Tailwind dark: variants", () => {
    it("generates dark:bg-card-dark with background-color", () => {
      const rule = findRule("bg-card-dark");
      expect(rule).toBeTruthy();
      expect(rule).toContain("background-color");
    });

    it("generates dark:border-border-dark", () => {
      expect(findRule("border-border-dark")).toBeTruthy();
    });

    it("generates dark:text-text-main", () => {
      expect(findRule("text-text-main")).toBeTruthy();
    });

    it("all dark: variant selectors require .dark ancestor", () => {
      const darkBlocks = css.split("}").filter((b) => b.includes("dark\\:"));
      expect(darkBlocks.length).toBeGreaterThan(0);
      for (const block of darkBlocks) {
        const selector = block.split("{")[0] ?? "";
        expect(selector).toContain(".dark");
      }
    });
  });

  describe("index.html body", () => {
    it("uses Tailwind bg-bg-light class for light background", () => {
      const bodyTag = html.match(/<body[^>]+>/)?.[0] ?? "";
      expect(bodyTag).toContain("bg-bg-light");
    });

    it("uses dark:bg-bg-dark for dark background", () => {
      const bodyTag = html.match(/<body[^>]+>/)?.[0] ?? "";
      expect(bodyTag).toContain("dark:bg-bg-dark");
    });

    it("uses dark:text-text-main for dark text", () => {
      const bodyTag = html.match(/<body[^>]+>/)?.[0] ?? "";
      expect(bodyTag).toContain("dark:text-text-main");
    });

    it("includes theme detection script", () => {
      expect(html).toContain("codex-proxy-theme");
      expect(html).toContain("prefers-color-scheme");
      expect(html).toContain("classList.add('dark')");
    });
  });
});
