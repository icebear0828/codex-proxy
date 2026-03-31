import { test, expect } from "vitest";
import { _electron as electron } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

test("builds, packages, and launches Electron app", async () => {
    // 1. Build & Pack using platform defaults (relies on electron-builder's current OS detection)
    console.log(`Building & Packaging for platform: ${process.platform}`);
    execSync("npm run build", { cwd: path.join(__dirname, ".."), stdio: "inherit" });
    execSync("npm run pack", { cwd: path.join(__dirname, ".."), stdio: "inherit" });

    // Determine the expected output directory
    let unpackedDirName = "";
    if (process.platform === "win32") {
        unpackedDirName = "win-unpacked";
    } else if (process.platform === "darwin") {
        unpackedDirName = "mac";
    } else {
        unpackedDirName = "linux-unpacked";
    }

    const unpackedDir = path.join(__dirname, "..", "release", unpackedDirName);
    expect(fs.existsSync(unpackedDir)).toBe(true);

    // 2. Locate the executable dynamically based on OS conventions
    let executablePath = "";
    if (process.platform === "darwin") {
        // App bundle on macOS
        const files = fs.readdirSync(unpackedDir);
        const appName = files.find(f => f.endsWith(".app"));
        expect(appName).toBeDefined();
        // Typically the binary is within Contents/MacOS/
        const binName = appName!.replace(".app", "");
        executablePath = path.join(unpackedDir, appName!, "Contents", "MacOS", binName);
    } else if (process.platform === "win32") {
        // .exe on Windows
        const files = fs.readdirSync(unpackedDir);
        const exeName = files.find(f => f.endsWith(".exe"));
        expect(exeName).toBeDefined();
        executablePath = path.join(unpackedDir, exeName!);
    } else {
        // Linux executable without extension
        const files = fs.readdirSync(unpackedDir);
        const binaryName = files.find(f =>
            !f.includes(".") &&
            f !== "locales" &&
            f !== "resources" &&
            f !== "chrome-sandbox" &&
            f !== "chrome_crashpad_handler" &&
            !fs.statSync(path.join(unpackedDir, f)).isDirectory()
        );
        expect(binaryName).toBeDefined();
        executablePath = path.join(unpackedDir, binaryName!);
    }

    expect(fs.existsSync(executablePath)).toBe(true);

    // Setup dummy user data directory to bypass prompt/setup state
    const userDataDir = path.join(__dirname, "..", "test-user-data");
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}

    // Create a local.yaml overlay in the test data dir to bypass native issues
    const dataDir = path.join(userDataDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "local.yaml"), "tls:\n  transport: curl-cli\n");

    // 3. Launch the app using Playwright
    console.log(`Launching ${executablePath}...`);
    const electronApp = await electron.launch({
        executablePath,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`],
        env: { ...process.env, DISABLE_NATIVE_TRANSPORT: "1" }
    });

    try {
      // Wait for the main window to open
      const window = await electronApp.firstWindow();
      expect(window).toBeDefined();

      const title = await window.title();
      console.log(`Window title: ${title}`);
      expect(title).toBe("Codex Proxy Developer Dashboard");
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      // 4. Clean exit
      await electronApp.close();
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    }
}, 120000);
