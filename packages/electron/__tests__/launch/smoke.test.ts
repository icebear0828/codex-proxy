import { test, expect } from "vitest";
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";

test("Electron app launches and window opens", async () => {
  // Find the linux-unpacked directory
  const releaseDir = path.join(import.meta.dirname, "../../release");
  const unpackedDirs = fs.readdirSync(releaseDir).filter(dir => dir.endsWith("-unpacked"));

  if (unpackedDirs.length === 0) {
    throw new Error(`No unpacked directory found in ${releaseDir}`);
  }

  const unpackedDir = path.join(releaseDir, unpackedDirs[0]);
  const executableName = "@codex-proxyelectron"; // electron-builder default for this name

  // Actually look for the binary
  const binaryCandidates = fs.readdirSync(unpackedDir).filter(f => !f.endsWith(".so") && !f.endsWith(".pak") && !f.endsWith(".bin") && !f.includes("."));
  const executablePath = path.join(unpackedDir, binaryCandidates.find(c => c === executableName || c === "codex-proxy") || binaryCandidates[0]);

  console.log(`Launching executable: ${executablePath}`);

  const electronApp = await electron.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const window = await electronApp.firstWindow();
  const title = await window.title();
  expect(title).toBeDefined();

  await electronApp.close();
});
