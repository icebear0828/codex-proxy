/**
 * Smoke test for Electron app launch.
 *
 * Verifies that the packaged application launches successfully
 * and the main window is created.
 */

import { _electron } from "playwright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { execFileSync } from "child_process";

const PKG_DIR = resolve(__dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");

describe("Electron launch smoke test", () => {
  let electronApp: any;

  beforeAll(async () => {
    // 1. Build electron bundles (esbuild)
    console.log("[Launch Test] Bundling electron code...");
    execFileSync("node", ["electron/build.mjs"], { cwd: PKG_DIR, stdio: "ignore" });

    // 2. Prepare pack (copies config/, public/ into packages/electron)
    console.log("[Launch Test] Preparing pack resources...");
    execFileSync("node", ["electron/prepare-pack.mjs"], { cwd: PKG_DIR, stdio: "ignore" });
  }, 120000); // Allow up to 2 minutes for builds

  afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
    // Clean up copied resources
    try {
      execFileSync("node", ["electron/prepare-pack.mjs", "--clean"], { cwd: PKG_DIR });
    } catch { /* ignore */ }
  }, 10000);

  it("launches the application and opens the main window", async () => {
    // Launch Electron via Playwright
    // --no-sandbox and related flags are critical for CI/headless environments
    electronApp = await _electron.launch({
      args: [".", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      cwd: PKG_DIR,
    });

    // Wait for the first BrowserWindow to be created
    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    // Verify the window title matches our app
    const title = await window.title();
    expect(title).toContain("Codex Proxy");

    // Ensure the window successfully loads without immediate crashes
    await window.waitForLoadState("domcontentloaded");

    // Close the app gracefully
    await electronApp.close();
    electronApp = null;
  }, 60000); // 60s timeout for launch and check
});
