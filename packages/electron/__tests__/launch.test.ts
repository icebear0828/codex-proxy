import { _electron as electron } from "playwright";
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";

describe("Electron app smoke test", () => {
  const PKG_DIR = resolve(__dirname, "..");

  beforeAll(() => {
    // 1. Build and pack (unpacked mode to save time)
    // First run the build script to generate main.cjs and server.mjs
    execSync("npm run build", { cwd: PKG_DIR, stdio: "ignore" });
    // Run prepack to copy config, public, bin
    execSync("npm run prepack", { cwd: PKG_DIR, stdio: "ignore" });
    // Package unpacked app
    execSync("npx electron-builder --config electron-builder.yml --dir -c.mac.identity=null", {
      cwd: PKG_DIR,
      stdio: "ignore",
      env: { ...process.env, PUBLISH_NEVER: "1" }
    });
  }, 120_000); // 2 minutes for packaging

  it("launches and opens main window", async () => {
    // 2. Find executable
    const platform = os.platform();
    let executablePath = "";
    if (platform === "win32") {
      executablePath = resolve(PKG_DIR, "release/win-unpacked/Codex Proxy.exe");
    } else if (platform === "darwin") {
      executablePath = resolve(PKG_DIR, "release/mac/Codex Proxy.app/Contents/MacOS/Codex Proxy");
      if (!existsSync(executablePath)) {
        executablePath = resolve(PKG_DIR, "release/mac-arm64/Codex Proxy.app/Contents/MacOS/Codex Proxy");
      }
    } else {
      executablePath = resolve(PKG_DIR, "release/linux-unpacked/@codex-proxyelectron");
    }

    expect(existsSync(executablePath)).toBe(true);

    // Create a dummy user data dir to bypass native transport errors
    const userDataDir = resolve(os.tmpdir(), `codex-proxy-test-${Date.now()}`);
    const dataDir = resolve(userDataDir, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, "local.yaml"), "tls:\n  transport: curl-cli\n");

    // 3. Launch with Playwright
    const app = await electron.launch({
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${userDataDir}`
      ],
      env: {
        ...process.env,
        DISABLE_NATIVE_TRANSPORT: "1"
      }
    });

    // 4. Verify main window
    const window = await app.firstWindow();
    expect(window).toBeTruthy();

    // The window might take a moment to load the URL
    await window.waitForLoadState("domcontentloaded");

    const title = await window.title();
    expect(title).toContain("Codex Proxy");

    // 5. Exit cleanly
    await app.close();

    // Cleanup
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {}
  }, 60_000);
});
