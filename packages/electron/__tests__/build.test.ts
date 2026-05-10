/**
 * Smoke test for esbuild bundling.
 *
 * Verifies that electron/build.mjs produces valid output files
 * with the expected exports.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { acquireElectronTestLock } from "./test-lock.js";

const PKG_DIR = resolve(import.meta.dirname, "..");
const DIST = resolve(PKG_DIR, "dist-electron");

describe("electron build (esbuild)", () => {
  let releaseLock: (() => void) | null = null;

  beforeAll(async () => {
    releaseLock = await acquireElectronTestLock();
  });

  // Build once for all tests in this suite
  const buildOnce = (() => {
    let built = false;
    return () => {
      if (built) return;
      execFileSync("node", ["electron/build.mjs"], {
        cwd: PKG_DIR,
        timeout: 30_000,
      });
      built = true;
    };
  })();

  afterAll(() => {
    // Clean up build output
    if (existsSync(DIST)) {
      rmSync(DIST, { recursive: true });
    }
    releaseLock?.();
  });

  it("produces main.cjs (Electron main process)", () => {
    buildOnce();
    const mainCjs = resolve(DIST, "main.cjs");
    expect(existsSync(mainCjs)).toBe(true);
    expect(statSync(mainCjs).size).toBeGreaterThan(1000);
  });

  it("produces server.mjs (backend server bundle)", () => {
    buildOnce();
    const serverMjs = resolve(DIST, "server.mjs");
    expect(existsSync(serverMjs)).toBe(true);
    expect(statSync(serverMjs).size).toBeGreaterThan(1000);
  });

  it("produces sourcemaps for both bundles", () => {
    buildOnce();
    expect(existsSync(resolve(DIST, "main.cjs.map"))).toBe(true);
    expect(existsSync(resolve(DIST, "server.mjs.map"))).toBe(true);
  });

  it("server.mjs exports setPaths and startServer", async () => {
    buildOnce();
    const serverMjs = resolve(DIST, "server.mjs");
    const mod = await import(serverMjs);
    expect(typeof mod.setPaths).toBe("function");
    expect(typeof mod.startServer).toBe("function");
  });

  // Regression: bundled CJS deps (e.g. `ws`) emit `__require("events")`
  // calls. In an ESM .mjs module `require` is undefined, so without a
  // banner that synthesizes one via `module.createRequire`, those calls
  // throw `Dynamic require of "events" is not supported` the moment
  // anything triggers the WS transport path. See build.mjs.
  it("server.mjs banner exposes a real require so __require resolves Node builtins", () => {
    buildOnce();
    const serverMjs = resolve(DIST, "server.mjs");
    const head = readFileSync(serverMjs, "utf-8").slice(0, 500);
    expect(head).toContain('from "module"');
    expect(head).toContain("createRequire");
  });
});
