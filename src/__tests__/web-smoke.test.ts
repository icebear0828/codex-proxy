import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { resolve } from "node:path";
import { spawn, ChildProcess } from "node:child_process";

describe("Web Dashboard Smoke Test", () => {
  let serverProcess: ChildProcess;
  const PORT = 8081;

  beforeAll(async () => {
    // Start the server
    serverProcess = spawn("node", ["dist/index.js"], {
      env: { ...process.env, PORT: PORT.toString(), DISABLE_NATIVE_TRANSPORT: "1" },
      stdio: "pipe",
    });

    serverProcess.stdout?.on("data", (data) => {
      console.log(`[Server STDOUT]: ${data.toString()}`);
    });

    serverProcess.stderr?.on("data", (data) => {
      console.error(`[Server STDERR]: ${data.toString()}`);
    });

    // Wait for the server to be ready
    await new Promise<void>((resolve, reject) => {
      let isReady = false;
      const timeout = setTimeout(() => {
        if (!isReady) {
          reject(new Error("Server start timeout"));
        }
      }, 10000);

      const checkHealth = async () => {
        try {
          const res = await fetch(`http://localhost:${PORT}/v1/models`);
          if (res.status === 200 || res.status === 401) {
            isReady = true;
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkHealth, 500);
          }
        } catch (e) {
          setTimeout(checkHealth, 500);
        }
      };

      checkHealth();
    });
  }, 15000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test("Vite builds CSS with light and dark theme rules", () => {
    const assetsDir = resolve(import.meta.dirname, "../../public/assets");
    expect(fs.existsSync(assetsDir)).toBe(true);

    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(file => file.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);

    const cssContent = fs.readFileSync(resolve(assetsDir, cssFiles[0]), "utf-8");
    // Tailwind class strategy dark mode output
    expect(cssContent).toMatch(/\.dark\\?:/);
    expect(cssContent).toContain("color-scheme");
  });

  test("Server responds with HTML containing <div id=\"app\"></div>", async () => {
    const res = await fetch(`http://localhost:${PORT}/`);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("<div id=\"app\"></div>");
  });
});
