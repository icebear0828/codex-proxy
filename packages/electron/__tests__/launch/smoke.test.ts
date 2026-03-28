import { _electron as electron } from "playwright";
import { expect, test } from "vitest";
import path from "path";
import fs from "fs";

test("Electron app launches and opens main window", async () => {
  const linuxUnpackedPath = path.join(
    import.meta.dirname,
    "../../release/linux-unpacked"
  );

  if (!fs.existsSync(linuxUnpackedPath)) {
    console.warn(`Skipping launch test: directory ${linuxUnpackedPath} not found. Run electron-builder first.`);
    return;
  }

  const files = fs.readdirSync(linuxUnpackedPath);
  const binaryName = files.find(
    (f) =>
      !f.includes(".") &&
      !f.includes("-") &&
      f !== "locales" &&
      f !== "resources" &&
      f !== "chrome_crashpad_handler" &&
      f !== "chrome-sandbox"
  );

  if (!binaryName) {
    throw new Error(`Could not find Linux binary in ${linuxUnpackedPath}`);
  }

  const executablePath = path.join(linuxUnpackedPath, binaryName);

  const electronApp = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const window = await electronApp.firstWindow();
    expect(window).toBeDefined();

    // Wait a brief moment to ensure window is fully initialized before we close it
    await window.waitForTimeout(1000);

  } finally {
    await electronApp.close();
  }
}, 60000);
