import { test, expect, describe, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";

describe("Web Frontend Smoke Test", () => {
  let serverProcess: ChildProcess | null = null;
  const PORT = 8081;

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test("Vite build outputs CSS with dark mode rules", () => {
    const assetsDir = path.resolve(import.meta.dirname, "../../public/assets");

    // Check if assets directory exists
    expect(fs.existsSync(assetsDir)).toBe(true);

    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));

    expect(cssFiles.length).toBeGreaterThan(0);

    let foundDarkTheme = false;
    for (const cssFile of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, cssFile), "utf-8");
      if (content.includes(".dark\\:") && content.includes("color-scheme: dark")) {
        foundDarkTheme = true;
        break;
      } else if (content.includes(".dark") || content.includes("color-scheme: dark")) {
        foundDarkTheme = true;
        break;
      }
    }

    expect(foundDarkTheme).toBe(true);
  });

  test("Server responds with HTML containing <div id=\"app\"></div>", async () => {
    // Explicitly set local.yaml with curl-cli transport to override native requirement for tests
    const dataDir = path.resolve(import.meta.dirname, "../../data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "local.yaml"), "tls:\n  transport: curl-cli\n");

    // Start server process
    const serverEntry = path.resolve(import.meta.dirname, "../../dist/index.js");

    serverProcess = spawn("node", [serverEntry], {
      env: {
        ...process.env,
        PORT: PORT.toString(),
        DISABLE_NATIVE_TRANSPORT: "1",
      },
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      let isResolved = false;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          reject(new Error("Timeout waiting for server to start"));
        }
      }, 15000);

      serverProcess?.stdout?.on("data", (data) => {
        const output = data.toString();
        if (output.includes("Listen:") || output.includes("Codex Proxy Server")) {
          isResolved = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess?.stderr?.on("data", (data) => {
        // Just log errors for debugging, but we rely on stdout or fetch to resolve
        console.error(`Server stderr: ${data}`);
      });

      serverProcess?.on("close", (code) => {
        if (!isResolved) {
          clearTimeout(timeout);
          reject(new Error(`Server closed with code ${code} before starting`));
        }
      });
    });

    // Fetch from server
    const response = await fetch(`http://localhost:${PORT}/`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("<div id=\"app\"></div>");
  }, 30000); // Higher timeout to give server time to start
});
