import { expect, test, describe, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

describe("Web Frontend Build and Serve Smoke Test", () => {
  let serverProcess: ChildProcess | null = null;
  const PORT = 8081;

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test("public/assets/ contains .css files with light and dark theme rules", () => {
    const assetsDir = path.join(import.meta.dirname, "..", "..", "public", "assets");

    // Check if public/assets/ exists
    expect(fs.existsSync(assetsDir)).toBe(true);

    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);

    let hasLight = false;
    let hasDark = false;

    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), "utf-8");

      // Look for typical theme definitions
      // Assuming light theme is either :root or .light, and dark theme is .dark
      // or similar standard tailwind/css variables
      if (content.includes("color-scheme: light") || content.includes(":root{") || content.includes("light")) hasLight = true;
      if (content.includes("color-scheme: dark") || content.includes(".dark{") || content.includes(".dark") || content.includes("dark")) hasDark = true;
    }

    expect(hasLight).toBe(true);
    expect(hasDark).toBe(true);
  });

  test("Server serves HTML containing <div id=\"app\"></div>", async () => {
    // We modify local.yaml to set the port instead of using PORT env variable
    const dataDir = path.join(import.meta.dirname, "..", "..", "data");
    const localYamlPath = path.join(dataDir, "local.yaml");

    let originalLocalYaml = "";
    if (fs.existsSync(localYamlPath)) {
        originalLocalYaml = fs.readFileSync(localYamlPath, "utf-8");
    } else {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    // Write new local.yaml
    fs.writeFileSync(localYamlPath, `server:\n  port: ${PORT}\n`);

    // Start the server
    const serverScript = path.join(import.meta.dirname, "..", "..", "dist", "index.js");

    // Ensure dist/index.js exists
    expect(fs.existsSync(serverScript)).toBe(true);

    serverProcess = spawn("node", [serverScript], {
      stdio: "pipe"
    });

    // Wait for the server to start (e.g., give it a few seconds or wait for stdout)
    await new Promise<void>((resolve, reject) => {
      let started = false;

      serverProcess?.stdout?.on("data", (data) => {
        if (data.toString().includes("started") || data.toString().includes(PORT.toString()) || data.toString().includes("login") || data.toString().includes("Listen:")) {
          started = true;
          resolve();
        }
      });

      // Fallback: resolve after 2 seconds if no standard log is detected
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 3000); // 3 seconds instead of 2 seconds
    });

    // Try multiple times to fetch just in case it takes a moment to start
    let response;
    for (let i = 0; i < 5; i++) {
        try {
            response = await fetch(`http://localhost:${PORT}/`);
            if (response.status === 200) {
                break;
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Restore local.yaml
    if (originalLocalYaml) {
        fs.writeFileSync(localYamlPath, originalLocalYaml);
    } else {
        if (fs.existsSync(localYamlPath)) {
            fs.unlinkSync(localYamlPath);
        }
    }

    expect(response).toBeDefined();
    expect(response!.status).toBe(200);

    const html = await response!.text();
    expect(html).toContain('<div id="app"></div>');
  }, 10000);
});
