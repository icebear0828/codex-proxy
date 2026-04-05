import { _electron as electron } from "playwright";
import { test, expect } from "vitest";
import fs from "fs";
import path from "path";
import { describe } from "vitest";

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)("Smoke E2E", () => {
test("Electron app packages and launches main window", async () => {
  const unpackedDir = path.resolve(import.meta.dirname, "../../release/linux-unpacked");

  // Find the executable dynamically
  const files = fs.readdirSync(unpackedDir);
  let executableName = "";
  for (const file of files) {
    // Looking for the main binary without extension on linux, avoiding .so and others
    if (!file.includes(".") && !file.includes("chrome-sandbox") && !file.includes("chrome_crashpad_handler")) {
      const stats = fs.statSync(path.join(unpackedDir, file));
      // check if it is a file and executable
      if (stats.isFile() && (stats.mode & 0o111)) { // is executable
        executableName = file;
        break;
      }
    }
  }

  // fallback to @codex-proxyelectron or codex-proxy just in case
  if (!executableName) {
    if (fs.existsSync(path.join(unpackedDir, "@codex-proxyelectron"))) {
      executableName = "@codex-proxyelectron";
    } else {
      executableName = "codex-proxy";
    }
  }

  const executablePath = path.join(unpackedDir, executableName);

  // Explicitly set the path to data/local.yaml inside the unpacked directory to disable native transport
  const userDataDir = path.join(unpackedDir, ".test-user-data");
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const dataDir = path.join(userDataDir, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "local.yaml"), "tls:\n  transport: curl-cli\n");

  const electronApp = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DISABLE_NATIVE_TRANSPORT: "1" }
  });

  electronApp.process().stdout?.on('data', data => console.log('stdout:', data.toString()));
  electronApp.process().stderr?.on('data', data => console.error('stderr:', data.toString()));

  // Wait for the first window to be created
  const window = await electronApp.firstWindow();
  expect(window).toBeTruthy();

  // Evaluate the number of windows
  const windowsLength = await electronApp.evaluate(({ app }) => {
    return app.getAllWindows().length;
  });
  expect(windowsLength).toBeGreaterThan(0);

  // Close the app cleanly
  await electronApp.close();
}, 60000); // Increased timeout for the smoke test
});
