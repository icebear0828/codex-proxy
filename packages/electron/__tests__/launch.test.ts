import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { execFileSync } from "child_process";
import { _electron as electron } from "@playwright/test";

const PKG_DIR = resolve(import.meta.dirname, "..");
const DIST = resolve(PKG_DIR, "dist-electron");
const RELEASE_DIR = resolve(PKG_DIR, "release");

describe("Electron Build, Pack & Launch", () => {
  // Set an extensive timeout because packaging and launching Electron takes time.
  beforeAll(() => {
    // We clean up dist-electron and release to ensure fresh builds
    if (existsSync(DIST)) {
      rmSync(DIST, { recursive: true, force: true });
    }
    if (existsSync(RELEASE_DIR)) {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Cleanup afterwards to not leave large build artifacts behind
    if (existsSync(RELEASE_DIR)) {
      rmSync(RELEASE_DIR, { recursive: true, force: true });
    }
    if (existsSync(DIST)) {
      rmSync(DIST, { recursive: true, force: true });
    }
  });

  it("should successfully build the electron package", () => {
    // Build electron workspace
    execFileSync("npm", ["run", "build"], {
      cwd: PKG_DIR,
      stdio: "inherit", // to see output if it fails
    });

    // Verify esbuild output
    expect(existsSync(resolve(DIST, "main.cjs"))).toBe(true);
    expect(existsSync(resolve(DIST, "server.mjs"))).toBe(true);
  }, 60000); // 1 minute for esbuild

  const getPackCommand = () => {
    if (process.platform === "win32") return "pack:win";
    if (process.platform === "darwin") return "pack:mac";
    return "pack:linux";
  };

  const getUnpackedDir = () => {
    if (process.platform === "win32") return "win-unpacked";
    if (process.platform === "darwin") return "mac-arm64"; // Might vary by host arch, simplified
    return "linux-unpacked";
  };

  it("should package the binary via electron-builder", () => {
    const packCmd = getPackCommand();
    execFileSync("npm", ["run", packCmd], {
      cwd: PKG_DIR,
      // electron-builder sometimes pipes incorrectly when stdio isn't properly handled in sandboxes.
      stdio: "ignore",
      env: { ...process.env, PUBLISH: "never" } // ensure we don't accidentally publish
    });

    expect(existsSync(RELEASE_DIR)).toBe(true);
    const unpackedDir = resolve(RELEASE_DIR, getUnpackedDir());
    // macOS might be `mac` or `mac-arm64` etc, checking existence of release dir is main thing
  }, 180000); // 3 minutes for packaging

  it("should successfully launch the packaged app and exit cleanly", async () => {
    const unpackedDir = resolve(RELEASE_DIR, getUnpackedDir());

    // Fallback if the strict unpacked dir wasn't found (e.g. mac-arm64 vs mac)
    const actualUnpackedDir = existsSync(unpackedDir)
      ? unpackedDir
      : (readdirSync(RELEASE_DIR).find(d => d.includes("mac") || d.includes("unpacked"))
         ? resolve(RELEASE_DIR, readdirSync(RELEASE_DIR).find(d => d.includes("mac") || d.includes("unpacked"))!)
         : unpackedDir);

    expect(existsSync(actualUnpackedDir)).toBe(true);

    // Find the executable. On Windows it's .exe, on macOS it's inside .app/Contents/MacOS, on Linux it's no extension
    let executablePath = "";
    if (process.platform === "win32") {
      const files = readdirSync(actualUnpackedDir);
      const exe = files.find(f => f.endsWith(".exe"));
      executablePath = join(actualUnpackedDir, exe!);
    } else if (process.platform === "darwin") {
      const files = readdirSync(actualUnpackedDir);
      const app = files.find(f => f.endsWith(".app"));
      executablePath = join(actualUnpackedDir, app!, "Contents", "MacOS", "Codex Proxy");
    } else {
      const files = readdirSync(actualUnpackedDir);
      const executableName = files.find(f => {
        const p = join(actualUnpackedDir, f);
        return !f.includes(".") && statSync(p).isFile() && !f.endsWith(".so");
      });
      executablePath = join(actualUnpackedDir, executableName!);
    }
    expect(existsSync(executablePath)).toBe(true);

    // Launch using Playwright
    const electronApp = await electron.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    const window = await electronApp.firstWindow();

    // Wait for the app to initialize and become ready
    await window.waitForLoadState("domcontentloaded");

    const title = await window.title();
    expect(title).toContain("Codex Proxy");

    // Close the app and ensure it exits cleanly
    await electronApp.close();
  }, 60000); // 1 minute for launch
});
