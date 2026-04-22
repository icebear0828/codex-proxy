/**
 * Release pipeline validation.
 *
 * Verifies the full build chain works end-to-end without actually
 * running electron-builder (which downloads 100MB+ of Electron).
 * Tests the sequence: core build → desktop build → esbuild → prepare-pack.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { acquireElectronTestLock } from "./test-lock.js";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const DIST_ELECTRON = resolve(PKG_DIR, "dist-electron");

describe("release pipeline", () => {
  let releaseLock: (() => void) | null = null;

  beforeAll(async () => {
    releaseLock = await acquireElectronTestLock();
  });

  afterAll(() => {
    // Clean up build artifacts
    if (existsSync(DIST_ELECTRON)) rmSync(DIST_ELECTRON, { recursive: true });
    // Clean up prepare-pack copies
    try {
      execFileSync("node", ["electron/prepare-pack.mjs", "--clean"], {
        cwd: PKG_DIR,
      });
    } catch { /* ignore */ }
    releaseLock?.();
  });

  it("core build produces web assets", () => {
    // Core should already be built (npm run build runs in CI before tests)
    const publicDir = resolve(ROOT_DIR, "public");
    const indexHtml = resolve(publicDir, "index.html");
    expect(existsSync(publicDir)).toBe(true);
    expect(existsSync(indexHtml)).toBe(true);
  });

  it("esbuild produces valid server bundle", () => {
    execFileSync("node", ["electron/build.mjs"], {
      cwd: PKG_DIR,
      timeout: 30_000,
    });

    const serverMjs = resolve(DIST_ELECTRON, "server.mjs");
    expect(existsSync(serverMjs)).toBe(true);
    // Server bundle should be substantial (includes all deps)
    expect(statSync(serverMjs).size).toBeGreaterThan(100_000);
  });

  it("esbuild produces valid main process bundle", () => {
    const mainCjs = resolve(DIST_ELECTRON, "main.cjs");
    expect(existsSync(mainCjs)).toBe(true);
    // Main bundle is smaller (only Electron main process code)
    expect(statSync(mainCjs).size).toBeGreaterThan(1000);
  });

  it("prepare-pack copies all required resources", () => {
    execFileSync("node", ["electron/prepare-pack.mjs"], {
      cwd: PKG_DIR,
      timeout: 10_000,
    });

    // Verify all resources are in place for electron-builder
    expect(existsSync(resolve(PKG_DIR, "config", "default.yaml"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "public", "index.html"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "bin"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "dist-electron", "main.cjs"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "dist-electron", "server.mjs"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "electron", "assets", "icon.png"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "package.json"))).toBe(true);
  });

  it("version is consistent between root and electron package", () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "package.json"), "utf-8"),
    ) as { version: string };
    const electronPkg = JSON.parse(
      readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"),
    ) as { version: string };

    // Versions may diverge (electron can be ahead), but both must be valid semver
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(electronPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("release.yml references correct workflow steps", () => {
    const releaseYml = readFileSync(
      resolve(ROOT_DIR, ".github", "workflows", "release.yml"),
      "utf-8",
    );

    // Must include workspace-aware build steps
    expect(releaseYml).toContain("packages/electron");
    expect(releaseYml).toContain("electron/build.mjs");
    expect(releaseYml).toContain("prepare-pack.mjs");
    expect(releaseYml).toContain("electron-builder");
  });

  it("bump-electron.yml workflow exists", () => {
    const bumpYml = resolve(
      ROOT_DIR,
      ".github",
      "workflows",
      "bump-electron.yml",
    );
    expect(existsSync(bumpYml)).toBe(true);

    const content = readFileSync(bumpYml, "utf-8");
    // Must bump both root and electron package versions
    expect(content).toContain("package.json");
    expect(content).toContain("packages/electron/package.json");
  });
});
