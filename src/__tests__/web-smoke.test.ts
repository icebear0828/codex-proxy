import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

let serverProcess: ChildProcess;
const PORT = 8081;

beforeAll(async () => {
  // Start server
  serverProcess = spawn("node", ["dist/index.js"], {
    env: { ...process.env, PORT: PORT.toString(), NODE_ENV: "production" }
  });

  // Wait for server to start
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start in time. Output: ${output}`));
    }, 5000);

    serverProcess.stdout?.on("data", (data) => {
      output += data.toString();
      if (output.includes(`Server is running on port ${PORT}`) || output.includes(`Server started`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data) => {
      console.error(`Server stderr: ${data}`);
    });

    // We should fallback to just wait some time if we can't see the console message.
    const fallbackTimeout = setTimeout(() => {
        clearTimeout(timeout);
        resolve();
    }, 2000);

    // Clean up fallback timeout if server starts up successfully before fallback triggers
    serverProcess.stdout?.on("data", (data) => {
      const outputStr = data.toString();
      if (outputStr.includes(`Server is running on port ${PORT}`) || outputStr.includes(`Server started`)) {
        clearTimeout(fallbackTimeout);
      }
    });
  });
});

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test("CSS output contains light and dark theme classes", () => {
  const assetsDir = path.join(import.meta.dirname, "../../public/assets");
  expect(fs.existsSync(assetsDir)).toBe(true);

  const files = fs.readdirSync(assetsDir);
  const cssFiles = files.filter(f => f.endsWith(".css"));

  expect(cssFiles.length).toBeGreaterThan(0);

  let hasDark = false;
  let hasLight = false;

  for (const file of cssFiles) {
    const content = fs.readFileSync(path.join(assetsDir, file), "utf-8");
    if (content.includes(".dark")) {
      hasDark = true;
    }
    // Often tailwind has :root for light variables or explicit .light
    if (content.includes(".light") || content.includes(":root")) {
      hasLight = true;
    }
  }

  expect(hasDark).toBe(true);
  expect(hasLight).toBe(true);
});

test("Server serves HTML with <div id=\"app\"></div>", async () => {
  const response = await fetch(`http://localhost:${PORT}/`);
  expect(response.status).toBe(200);

  const text = await response.text();
  expect(text).toContain('<div id="app"></div>');
});
