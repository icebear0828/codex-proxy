import { test, expect } from "vitest";
import { _electron as electron } from "playwright";
import fs from "fs";
import path from "path";

test("Electron app packages and launches", async () => {
  // Find the linux-unpacked directory
  const releaseDir = path.join(import.meta.dirname, "../../release/linux-unpacked");

  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory not found: ${releaseDir}`);
  }

  // Find the executable
  const files = fs.readdirSync(releaseDir);
  const executable = files.find(f => {
    const fullPath = path.join(releaseDir, f);
    return fs.statSync(fullPath).isFile() && !f.includes(".") && f !== "chrome-sandbox" && f !== "chrome_crashpad_handler";
  });

  if (!executable) {
    throw new Error(`Executable not found in ${releaseDir}`);
  }

  const executablePath = path.join(releaseDir, executable);

  // Launch the app
  const app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });

  try {
    // Wait for the first window
    const window = await app.firstWindow();

    // Check if window is visible
    expect(window).toBeDefined();

    // Get title
    const title = await window.title();
    expect(title).toBeDefined();
  } finally {
    // Cleanly close
    await app.close();
  }
}, 60000);
