import { _electron as electron } from "playwright";
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import fs from "node:fs";

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)(
  "Electron App Smoke Test",
  () => {
    let electronApp: Awaited<ReturnType<typeof electron.launch>>;

    beforeAll(async () => {
      const isLinux = process.platform === "linux";

      let executablePath = "";
      if (isLinux) {
        executablePath = resolve(
          import.meta.dirname,
          "../../release/linux-unpacked/@codex-proxyelectron"
        );
      } else if (process.platform === "darwin") {
        executablePath = resolve(
          import.meta.dirname,
          "../../release/mac/Codex Proxy.app/Contents/MacOS/Codex Proxy"
        );
      } else if (process.platform === "win32") {
        executablePath = resolve(
          import.meta.dirname,
          "../../release/win-unpacked/Codex Proxy.exe"
        );
      }

      if (!fs.existsSync(executablePath)) {
        throw new Error(`Executable not found at ${executablePath}. Did you run electron-builder?`);
      }

      const userDataDir = resolve(
        import.meta.dirname,
        "../../.test-user-data"
      );

      // Create local.yaml to avoid native transport issues
      const localYamlPath = resolve(userDataDir, "data", "local.yaml");
      fs.mkdirSync(resolve(userDataDir, "data"), { recursive: true });
      fs.writeFileSync(localYamlPath, "tls:\n  transport: curl-cli\n");

      electronApp = await electron.launch({
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${userDataDir}`,
        ],
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: "1",
          DISABLE_NATIVE_TRANSPORT: "1",
        },
      });

      electronApp.process().stdout?.on("data", (data: Buffer) => {
        console.log(`[Electron STDOUT]: ${data.toString()}`);
      });
      electronApp.process().stderr?.on("data", (data: Buffer) => {
        console.error(`[Electron STDERR]: ${data.toString()}`);
      });
    }, 60000);

    afterAll(async () => {
      if (electronApp) {
        await electronApp.close();
      }
    });

    test("launches and opens a window", async () => {
      // Get the first window
      const window = await electronApp.firstWindow();
      expect(window).toBeDefined();

      // Wait for the window to load
      await window.waitForLoadState("domcontentloaded");

      // Verify the title (it could be anything, but let's check it's a string)
      const title = await window.title();
      expect(typeof title).toBe("string");
    }, 30000);
  }
);
