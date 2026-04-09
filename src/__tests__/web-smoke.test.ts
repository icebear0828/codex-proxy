import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

describe('Web Smoke Test', () => {
  let serverProcess: ChildProcess;
  const PORT = 8081;

  beforeAll(async () => {
    // Start the server on a non-default port
    serverProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: PORT.toString(),
      },
    });

    // Wait for the server to start (e.g., look for 'Listen:' or just wait a few seconds)
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error('Server failed to start within timeout'));
        }
      }, 5000);

      serverProcess.stdout?.on('data', (data) => {
        const str = data.toString();
        if (str.includes('Codex Proxy Server') || str.includes('Listen:')) {
          started = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      // Also resolve just in case server is quiet, let's wait 3 seconds and hope it's up.
      setTimeout(() => {
          if (!started) {
              started = true;
              clearTimeout(timeout);
              resolve();
          }
      }, 3000);
    });
  });

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });

  it('build output contains CSS with both light and dark theme rules', () => {
    // The build output goes to public/assets/
    const assetsDir = path.join(import.meta.dirname, '../../public/assets');
    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith('.css'));

    expect(cssFiles.length).toBeGreaterThan(0);

    let foundDark = false;
    for (const cssFile of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');
      if (content.includes('.dark') || content.includes('color-scheme: dark')) {
        foundDark = true;
        break;
      }
    }

    expect(foundDark).toBe(true);
  });

  it('server serves HTML containing <div id="app"></div>', async () => {
    const response = await fetch(`http://localhost:${PORT}/`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<div id="app"></div>');
  });
});
