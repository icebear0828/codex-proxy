import { expect, test, describe } from "vitest";
import { _electron as electron } from "playwright";
import * as fs from "fs";
import * as path from "path";

describe("Electron Launch Smoke Test", () => {
  test("application can be packaged and launched", async () => {
    // Determine path to the unpacked executable
    const releaseDir = path.join(import.meta.dirname, "..", "..", "release", "linux-unpacked");
    expect(fs.existsSync(releaseDir), `Release directory ${releaseDir} does not exist`).toBe(true);

    // Find the executable in the release directory
    const files = fs.readdirSync(releaseDir);
    const executableName = files.find(f => {
      const stats = fs.statSync(path.join(releaseDir, f));
      // We look for the main executable by checking for an executable file
      // that does not match common resource extensions
      return stats.isFile() &&
             (stats.mode & fs.constants.S_IXUSR) &&
             !f.endsWith(".so") &&
             !f.endsWith(".pak") &&
             !f.endsWith(".bin") &&
             !f.endsWith(".dat") &&
             !f.includes("."); // Unix binaries typically lack extension in electron-builder
    });

    // Actually the binary name in linux-unpacked is usually `@codex-proxyelectron` or whatever is defined as product name
    expect(executableName, "Could not find executable binary in release dir").toBeTruthy();

    const executablePath = path.join(releaseDir, executableName as string);

    // Launch the app
    const electronApp = await electron.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    try {
      // Verify main window opens
      const window = await electronApp.firstWindow();
      expect(window).toBeTruthy();
    } finally {
      // Close cleanly
      await electronApp.close();
    }
  }, 60000);
});
