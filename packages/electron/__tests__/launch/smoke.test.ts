import { _electron as electron } from "playwright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)("Electron Launch Smoke Test", () => {
  let app: Awaited<ReturnType<typeof electron.launch>>;

  beforeAll(async () => {
    const platform = os.platform();
    let executablePath = "";

    // Resolve unpack directory dynamically based on platform
    if (platform === "linux") {
      executablePath = path.join(import.meta.dirname, "../../release/linux-unpacked/@codex-proxyelectron");
    } else if (platform === "darwin") {
      executablePath = path.join(import.meta.dirname, "../../release/mac/Codex Proxy.app/Contents/MacOS/Codex Proxy");
    } else if (platform === "win32") {
      executablePath = path.join(import.meta.dirname, "../../release/win-unpacked/Codex Proxy.exe");
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    if (!fs.existsSync(executablePath)) {
      throw new Error(`Executable not found at ${executablePath}. Did you run 'npm run pack:linux' (or win/mac) first?`);
    }

    // Set environment variable to enable logging for debugging native startup crashes
    process.env.ELECTRON_ENABLE_LOGGING = "1";

    app = await electron.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    app.process().stdout?.on("data", (data) => console.log(`[Electron STDOUT] ${data.toString()}`));
    app.process().stderr?.on("data", (data) => console.error(`[Electron STDERR] ${data.toString()}`));
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("should open the main window", async () => {
    const window = await app.firstWindow();
    expect(window).not.toBeNull();
    const title = await window.title();
    expect(title).toContain("Codex Proxy");
  });
});
