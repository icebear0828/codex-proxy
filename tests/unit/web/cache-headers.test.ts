/**
 * Verify that web routes set correct Cache-Control headers.
 *
 * - index.html (/): no-cache — browser must revalidate every time
 * - /assets/*: immutable — Vite uses content-hashed filenames
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const WEB_TS_PATH = resolve(__dirname, "../../../src/routes/web.ts");

describe("web.ts cache headers", () => {
  const source = readFileSync(WEB_TS_PATH, "utf-8");

  it("sets no-cache on index.html (web)", () => {
    // The "/" route should set Cache-Control: no-cache before returning html
    const indexRouteMatch = source.match(/app\.get\("\/",[\s\S]*?return c\.html\(html\)/);
    expect(indexRouteMatch).not.toBeNull();
    expect(indexRouteMatch![0]).toContain('Cache-Control');
    expect(indexRouteMatch![0]).toContain('no-cache');
  });

  it("sets immutable cache on /assets/*", () => {
    // The "/assets/*" middleware should set immutable cache
    const assetsMatch = source.match(/app\.use\("\/assets\/\*"[\s\S]*?serveStatic/);
    expect(assetsMatch).not.toBeNull();
    expect(assetsMatch![0]).toContain('immutable');
  });
});
