import { _electron as electron } from 'playwright';
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)('Electron App Launch', () => {
  it('launches successfully and exits cleanly', async () => {
    let executablePath = '';
    if (process.platform === 'win32') {
      executablePath = resolve(import.meta.dirname, '../release/win-unpacked/Codex Proxy.exe');
    } else if (process.platform === 'darwin') {
      executablePath = resolve(import.meta.dirname, '../release/mac/Codex Proxy.app/Contents/MacOS/Codex Proxy');
    } else {
      executablePath = resolve(import.meta.dirname, '../release/linux-unpacked/@codex-proxyelectron');
    }

    const electronApp = await electron.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        DISABLE_NATIVE_TRANSPORT: '1'
      }
    });

    electronApp.process().stdout?.on('data', (data) => console.log(`stdout: ${data}`));
    electronApp.process().stderr?.on('data', (data) => console.error(`stderr: ${data}`));

    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    await electronApp.close();
  }, 60000);
});
