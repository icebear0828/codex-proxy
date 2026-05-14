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

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function parseCssColor(value: string | undefined): RgbColor {
  if (!value) {
    throw new Error("Missing CSS color value");
  }

  const trimmed = value.trim();
  const hex = trimmed.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }

  const channels = trimmed.split(/\s+/).map((part) => Number.parseFloat(part));
  if (channels.length === 3 && channels.every((channel) => Number.isFinite(channel))) {
    const [r, g, b] = channels;
    return { r, g, b };
  }

  throw new Error(`Unsupported CSS color format: ${value}`);
}

function toLinearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * toLinearChannel(color.r) +
    0.7152 * toLinearChannel(color.g) +
    0.0722 * toLinearChannel(color.b)
  );
}

function contrastRatio(foreground: RgbColor, background: RgbColor): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrastAtLeast(foreground: string | undefined, background: string | undefined, ratio: number) {
  const contrast = contrastRatio(parseCssColor(foreground), parseCssColor(background));
  expect(contrast).toBeGreaterThanOrEqual(ratio);
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

    it("defines semantic action and status tokens in both themes", () => {
      const required = [
        "--primary",
        "--primary-action",
        "--primary-action-hover",
        "--primary-container",
        "--success",
        "--success-container",
        "--warning",
        "--warning-container",
        "--danger",
        "--danger-container",
        "--avatar-blue-text",
        "--avatar-blue-bg",
      ];

      for (const token of required) {
        expect(getRootVars()[token], `:root ${token}`).toBeDefined();
        expect(getDarkVars()[token], `.dark ${token}`).toBeDefined();
      }
    });

    it("uses the green palette for primary action/status tokens instead of dark emerald", () => {
      const root = getRootVars();
      const dark = getDarkVars();

      expect(root["--primary"]).toBe("21 128 61");
      expect(root["--primary-hover"]).toBe("22 101 52");
      expect(root["--primary-action"]).toBe("21 128 61");
      expect(root["--primary-action-hover"]).toBe("22 101 52");
      expect(root["--success"]).toBe("21 128 61");
      expect(root["--avatar-emerald-text"]).toBe("21 128 61");
      expect(root["--avatar-emerald-bg"]).toBe("220 252 231");

      expect(dark["--primary"]).toBe("74 222 128");
      expect(dark["--primary-hover"]).toBe("34 197 94");
      expect(dark["--primary-action"]).toBe("21 128 61");
      expect(dark["--primary-action-hover"]).toBe("22 101 52");
      expect(dark["--success"]).toBe("74 222 128");
      expect(dark["--avatar-emerald-text"]).toBe("74 222 128");
      expect(dark["--avatar-emerald-bg"]).toBe("20 83 45");

      expect(root["--primary-action"]).not.toBe("4 120 87");
      expect(dark["--primary-action"]).not.toBe("4 120 87");
    });

    it("keeps primary/action/status color pairs WCAG AA contrast-safe", () => {
      const root = getRootVars();
      const dark = getDarkVars();
      const white = "#ffffff";
      const darkCanvas = "#0d1117";

      expectContrastAtLeast(root["--primary"], white, 4.5);
      expectContrastAtLeast(dark["--primary"], darkCanvas, 4.5);
      expectContrastAtLeast(white, root["--primary-action"], 4.5);
      expectContrastAtLeast(white, dark["--primary-action"], 4.5);
      expectContrastAtLeast(root["--primary"], root["--primary-container"], 4.5);
      expectContrastAtLeast(dark["--primary"], dark["--primary-container"], 4.5);
      expectContrastAtLeast(root["--success"], root["--success-container"], 4.5);
      expectContrastAtLeast(dark["--success"], dark["--success-container"], 4.5);
      expectContrastAtLeast(root["--warning"], root["--warning-container"], 4.5);
      expectContrastAtLeast(dark["--warning"], dark["--warning-container"], 4.5);
      expectContrastAtLeast(root["--danger"], root["--danger-container"], 4.5);
      expectContrastAtLeast(dark["--danger"], dark["--danger-container"], 4.5);
      expectContrastAtLeast(root["--avatar-blue-text"], root["--avatar-blue-bg"], 4.5);
      expectContrastAtLeast(dark["--avatar-blue-text"], dark["--avatar-blue-bg"], 4.5);
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
