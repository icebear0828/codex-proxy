import { expect, test, describe, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

describe("web frontend smoke test", () => {
  let serverProcess: ChildProcess | null = null;

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
    // Clean up local config created for tests
    const dataDir = path.join(import.meta.dirname, "../../data");
    const localYamlPath = path.join(dataDir, "local.yaml");
    if (fs.existsSync(localYamlPath)) {
      fs.unlinkSync(localYamlPath);
    }
  });

  test("public/assets/ contains .css files with both light and dark theme rules", () => {
    const assetsDir = path.join(import.meta.dirname, "../../public/assets");
    expect(fs.existsSync(assetsDir)).toBe(true);

    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));

    expect(cssFiles.length).toBeGreaterThan(0);

    let hasDarkTheme = false;
    for (const cssFile of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, cssFile), "utf-8");
      // The CSS uses Tailwind's .dark class strategy, not prefers-color-scheme media query
      if (content.includes(".dark") && content.includes("color-scheme:dark")) {
        hasDarkTheme = true;
      }
    }

    expect(hasDarkTheme).toBe(true);
  });

  test("GET / returns HTML containing <div id=\"app\"></div>", async () => {
    const port = 8081;

    // Create local.yaml if needed to disable native transport properly
    const dataDir = path.join(import.meta.dirname, "../../data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const localYamlPath = path.join(dataDir, "local.yaml");
    fs.writeFileSync(localYamlPath, "tls:\n  transport: curl-cli\n");

    const configDir = path.join(import.meta.dirname, "../../config");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const defaultYamlPath = path.join(configDir, "default.yaml");
    if (!fs.existsSync(defaultYamlPath)) {
      fs.writeFileSync(defaultYamlPath, "server:\n  port: 8080\n");
    }

    const fingerprintYamlPath = path.join(configDir, "fingerprint.yaml");
    if (!fs.existsSync(fingerprintYamlPath)) {
      fs.writeFileSync(fingerprintYamlPath, "");
    }

    // Start the server
    serverProcess = spawn("node", ["dist/index.js"], {
      env: {
        ...process.env,
        PORT: port.toString(),
        DISABLE_NATIVE_TRANSPORT: "1",
      },
    });

    // Wait for the server to be ready
    await new Promise<void>((resolve, reject) => {
      if (!serverProcess) return reject(new Error("Process not started"));

      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for server to start"));
      }, 10000);

      serverProcess.stdout?.on("data", (data) => {
        const output = data.toString();
        if (output.includes("Codex Proxy Server") || output.includes("Listen:")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error(`Server stderr: ${data}`);
      });
    });

    // Fetch the frontend
    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<div id="app"></div>');
  }, 15000);
});
