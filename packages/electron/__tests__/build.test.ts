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

  // Runtime regression: the banner-string assertion above is necessary
  // but not sufficient. esbuild could change `__require`'s shim shape,
  // or `ws` could be replaced by another lazy-CJS dependency, and the
  // banner check would still pass while the bundle explodes at runtime.
  //
  // The only way to be sure is to actually instantiate the bundled
  // ws module so that ws/lib/websocket.js's `__require("events")` /
  // `__require("https")` chain executes. If the banner is missing or
  // broken, those throw `Dynamic require of "X" is not supported`.
  //
  // CRITICAL: this MUST run in a fresh Node subprocess, not in-process
  // via vitest's `await import(...)`. vite-node injects a `require`
  // into the ESM module scope, which masks the bug — the bundle that
  // would crash inside Electron's real Node loader passes silently
  // here. A `node --input-type=module` subprocess matches Electron's
  // runtime semantics: globally-undefined `require`, `__require` shim
  // is forced through its throwing branch unless the banner has
  // already synthesized a real `require` via `module.createRequire`.
  it("server.mjs loadWebSocketModule actually instantiates bundled ws under native Node", () => {
    buildOnce();
    const serverMjs = resolve(DIST, "server.mjs");

    // The script imports the bundle and forces ws's lazy CJS factory
    // to run. Stdout marker proves end-to-end success; any throw from
    // the bundle surfaces as a non-zero exit + stderr.
    const script = `
      const mod = await import(${JSON.stringify(serverMjs)});
      if (typeof mod.loadWebSocketModule !== "function") {
        console.error("loadWebSocketModule export missing");
        process.exit(2);
      }
      const WS = await mod.loadWebSocketModule();
      if (typeof WS !== "function" || !/WebSocket$/.test(WS.name)) {
        console.error("loadWebSocketModule did not return a WebSocket constructor (got: " + typeof WS + " " + (WS && WS.name) + ")");
        process.exit(3);
      }
      console.log("OK:" + WS.name);
    `;

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execFileSync(
        "node",
        ["--input-type=module", "-e", script],
        { cwd: PKG_DIR, timeout: 30_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? e.message ?? "";
      exitCode = e.status ?? -1;
    }

    expect(stderr, `subprocess stderr:\n${stderr}\nstdout:\n${stdout}`).not.toMatch(
      /Dynamic require of/,
    );
    expect(exitCode, `subprocess exited ${exitCode}\nstderr:\n${stderr}`).toBe(0);
    expect(stdout.trim()).toMatch(/^OK:.*WebSocket$/);
  });
});
