import { _electron as electron } from "playwright";
import { expect, test } from "vitest";

test.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)(
  "electron smoke test - packaging and launch",
  async () => {
    // Launch the electron app
    const electronApp = await electron.launch({
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "."],
      cwd: import.meta.dirname + "/../../",
    });

    const window = await electronApp.firstWindow();

    // Wait for the window to load
    await window.waitForLoadState("domcontentloaded");

    // Check that we can get the title, which means the app didn't crash
    const title = await window.title();
    expect(title).toBeDefined();

    // Close cleanly
    await electronApp.close();
  },
  60000 // 60 seconds timeout
);
