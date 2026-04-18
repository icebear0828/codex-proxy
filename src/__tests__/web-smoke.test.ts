import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";

describe("Web Smoke Test", () => {
  let serverProcess: ChildProcess;
  const PORT = 8081;

  beforeAll(async () => {
    // Start the server
    serverProcess = spawn("node", ["dist/index.js"], {
      env: {
        ...process.env,
        PORT: PORT.toString(),
        DISABLE_NATIVE_TRANSPORT: "1",
      },
    });

    // Wait for the server to fully start
    await new Promise<void>((resolve, reject) => {
      let output = "";
      serverProcess.stdout?.on("data", (data) => {
        output += data.toString();
        if (output.includes("Listen:")) {
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error(`[Server STDERR]: ${data.toString()}`);
      });

      serverProcess.on("error", reject);

      // Safety timeout
      setTimeout(() => reject(new Error("Timeout waiting for server to start")), 10000);
    });
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  it("should contain CSS files with dark mode rules in public/assets/", () => {
    const assetsDir = path.join(import.meta.dirname, "../../public/assets");
    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));

    expect(cssFiles.length).toBeGreaterThan(0);

    let hasDarkTheme = false;
    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), "utf-8");
      if (content.includes(".dark") || content.includes("color-scheme")) {
        hasDarkTheme = true;
        break;
      }
    }

    expect(hasDarkTheme).toBe(true);
  });

  it("should serve the web app on the root endpoint", async () => {
    const html = await new Promise<string>((resolve, reject) => {
      http.get(`http://localhost:${PORT}/`, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });

    expect(html).toContain('<div id="app"></div>');
  });
});
