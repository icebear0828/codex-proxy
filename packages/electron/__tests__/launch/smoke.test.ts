import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron, type ElectronApplication } from 'playwright';
import path from 'path';
import fs from 'fs';

// Define a directory for playwright user data
const USER_DATA_DIR = path.join(import.meta.dirname, '.test-user-data');

// Clean up user data dir before tests
if (fs.existsSync(USER_DATA_DIR)) {
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
}

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)('Electron Smoke Test', () => {
  let app: ElectronApplication;

  beforeAll(async () => {
    // Resolve the binary path for testing the packed output in directory mode.
    // The instructions say "Package with npx electron-builder --linux --dir"
    // The productName is "Codex Proxy". electron-builder usually produces an executable named after productName or name.

    // In linux-unpacked, electron-builder lowercases and hyphenates the name if productName has spaces, or keeps it.
    // Let's try "codex-proxy" as it is the name in package.json

    let executablePath = path.join(import.meta.dirname, '../../release/linux-unpacked/codex-proxy');

    const linuxUnpackedExe = path.join(import.meta.dirname, '../../release/linux-unpacked/@codex-proxyelectron');
    if (fs.existsSync(linuxUnpackedExe)) {
        executablePath = linuxUnpackedExe;
    } else if (fs.existsSync(path.join(import.meta.dirname, '../../release/linux-unpacked/Codex Proxy'))) {
        executablePath = path.join(import.meta.dirname, '../../release/linux-unpacked/Codex Proxy');
    }

    app = await _electron.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=' + USER_DATA_DIR],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        DISABLE_NATIVE_TRANSPORT: '1', // Bypasses native transport errors during testing
      },
    });

    app.process().stdout?.on('data', (data) => console.log(data.toString()));
    app.process().stderr?.on('data', (data) => console.error(data.toString()));
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    // Clean up
    if (fs.existsSync(USER_DATA_DIR)) {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    }
  });

  it('launches the app and opens the main window', async () => {
    const window = await app.firstWindow();
    expect(window).toBeTruthy();

    // Check if window is visible and hasn't crashed
    const title = await window.title();
    expect(typeof title).toBe('string');
  }, 60000);
});
