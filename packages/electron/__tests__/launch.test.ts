import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)('Electron Launch Smoke Test', () => {
  let app: ElectronApplication;

  beforeAll(async () => {
    // We pass an empty string to use the built executable
    let executablePath = '';
    if (process.platform === 'win32') {
      executablePath = path.join(rootDir, 'release', 'win-unpacked', 'Codex Proxy.exe');
    } else if (process.platform === 'darwin') {
      executablePath = path.join(rootDir, 'release', 'mac', 'Codex Proxy.app', 'Contents', 'MacOS', 'Codex Proxy');
    } else {
      executablePath = path.join(rootDir, 'release', 'linux-unpacked', '@codex-proxyelectron');
    }

    // We need to bypass native transport errors by either disabling or supplying curl-cli in local.yaml
    const userDataDir = path.join(rootDir, 'release', '.test-user-data');

    app = await electron.launch({
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--user-data-dir=${userDataDir}`,
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DISABLE_NATIVE_TRANSPORT: '1',
        ELECTRON_ENABLE_LOGGING: '1', // Important for seeing errors
      },
    });

    app.process().stdout?.on('data', (data) => console.log(`stdout: ${data.toString()}`));
    app.process().stderr?.on('data', (data) => console.error(`stderr: ${data.toString()}`));
  }, 60000); // Allow time to launch

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  }, 20000);

  it('launches successfully and opens the main window', async () => {
    const window = await app.firstWindow();
    expect(window).toBeTruthy();

    // Check if the window is visible and not crashed
    const isClosed = window.isClosed();
    expect(isClosed).toBe(false);

    // Optionally wait for some title or element to be sure the frontend is loaded,
    // but simply verifying the window isn't crashed satisfies the smoke test requirements.
    const title = await window.title();
    expect(title).toBeTypeOf('string'); // The app has some title
  }, 30000);
});
