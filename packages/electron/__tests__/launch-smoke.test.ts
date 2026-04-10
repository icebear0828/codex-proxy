import { test, expect, describe } from 'vitest';
import { _electron as electron } from 'playwright';
import { join } from 'path';

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)('Electron App Launch Smoke Test', () => {
  test('Launches and main window opens', async () => {
    const executablePath = join(__dirname, '..');
    const electronApp = await electron.launch({
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', executablePath],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
      }
    });

    electronApp.process().stdout?.on('data', (d) => console.log(`stdout: ${d.toString()}`));
    electronApp.process().stderr?.on('data', (d) => console.error(`stderr: ${d.toString()}`));

    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    const title = await window.title();
    expect(title).toBe('Codex Proxy Developer Dashboard');

    await electronApp.close();
  }, 60000);
});
