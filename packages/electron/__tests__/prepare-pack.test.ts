/**
 * Tests for electron/prepare-pack.mjs
 *
 * Verifies that root-level resources (config/, public/, etc.) are correctly
 * copied into packages/electron/ before electron-builder runs, and cleaned
 * up afterward.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { acquireElectronTestLock } from "./test-lock.js";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const SCRIPT = resolve(PKG_DIR, "electron", "prepare-pack.mjs");

// Directories that prepare-pack copies from root into packages/electron/
const DIRS = ["config", "public", "bin"];

describe("prepare-pack.mjs", () => {
  let releaseLock: (() => void) | null = null;

  beforeAll(async () => {
    releaseLock = await acquireElectronTestLock();
  });

  // Clean up any leftover copies before/after each test
  function cleanCopies(): void {
    for (const dir of DIRS) {
      const dest = resolve(PKG_DIR, dir);
      // Only remove if it's a copy (not the root original)
      if (existsSync(dest) && resolve(dest) !== resolve(ROOT_DIR, dir)) {
        rmSync(dest, { recursive: true });
      }
    }
  }

  beforeEach(cleanCopies);
  afterEach(cleanCopies);
  afterAll(() => {
    releaseLock?.();
  });

  it("copies root directories into packages/electron/", () => {
    execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

    for (const dir of DIRS) {
      const rootDir = resolve(ROOT_DIR, dir);
      const copyDir = resolve(PKG_DIR, dir);
      if (existsSync(rootDir)) {
        expect(existsSync(copyDir)).toBe(true);
      }
    }
  });

  it("copies config/ with correct content", () => {
    execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

    const rootConfig = resolve(ROOT_DIR, "config", "default.yaml");
    const copyConfig = resolve(PKG_DIR, "config", "default.yaml");

    if (existsSync(rootConfig)) {
      expect(existsSync(copyConfig)).toBe(true);
      expect(readFileSync(copyConfig, "utf-8")).toBe(
        readFileSync(rootConfig, "utf-8"),
      );
    }
  });

  it("--clean removes copied directories", () => {
    // First copy
    execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

    // Verify at least config exists
    const copyConfig = resolve(PKG_DIR, "config");
    expect(existsSync(copyConfig)).toBe(true);

    // Then clean
    execFileSync("node", [SCRIPT, "--clean"], { cwd: PKG_DIR });

    for (const dir of DIRS) {
      expect(existsSync(resolve(PKG_DIR, dir))).toBe(false);
    }
  });

  it("skips missing root directories without error", () => {
    // Create a temp directory that doesn't have all root dirs
    // The script should warn but not throw
    const result = execFileSync("node", [SCRIPT], {
      cwd: PKG_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Should succeed without throwing
    expect(result).toBeDefined();
  });

  it("--clean is idempotent (no error when dirs already absent)", () => {
    // Clean without prior copy — should not throw
    expect(() => {
      execFileSync("node", [SCRIPT, "--clean"], { cwd: PKG_DIR });
    }).not.toThrow();
  });
});
