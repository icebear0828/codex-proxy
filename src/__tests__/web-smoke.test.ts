import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let serverProcess: ChildProcess;

beforeAll(async () => {
  // Start server
  const env = { ...process.env, PORT: "8081" };
  const indexPath = path.join(import.meta.dirname, "../../dist/index.js");

  serverProcess = spawn("node", [indexPath], { env, stdio: "inherit" });

  // Wait a bit for server to start
  await new Promise(resolve => setTimeout(resolve, 2000));
}, 10000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test("CSS assets have light and dark theme rules", () => {
  const assetsDir = path.join(import.meta.dirname, "../../public/assets");
  const files = fs.readdirSync(assetsDir);
  const cssFiles = files.filter(f => f.endsWith(".css"));

  expect(cssFiles.length).toBeGreaterThan(0);

  let foundDarkTheme = false;

  for (const cssFile of cssFiles) {
    const cssContent = fs.readFileSync(path.join(assetsDir, cssFile), "utf-8");
    if (cssContent.includes("@media (prefers-color-scheme: dark)") || cssContent.includes("dark:")) {
      foundDarkTheme = true;
      break;
    }
  }

  expect(foundDarkTheme).toBe(true);
});

test("Server serves HTML with #app div", async () => {
  const response = await fetch("http://localhost:8081/");
  expect(response.status).toBe(200);

  const html = await response.text();
  expect(html).toContain('<div id="app"></div>');
});
