import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { setPaths } from "../../src/paths.js";
import { loadConfig } from "../../src/config.js";
import { dashboardAuth } from "../../src/middleware/dashboard-auth.js";
import { createErrorLogRoutes } from "../../src/routes/admin/error-logs.js";
import { createDashboardAuthRoutes } from "../../src/routes/dashboard-login.js";

// 1. 初始化物理临时目录并使用 setPaths 重定向 dataDir
const tmpDataDir = mkdtempSync(resolve(tmpdir(), "e2e-errlogs-"));
setPaths({
  rootDir: process.cwd(),
  configDir: resolve(process.cwd(), "config"),
  dataDir: tmpDataDir,
  binDir: resolve(process.cwd(), "bin"),
  publicDir: resolve(process.cwd(), "public"),
});

// 2. 覆盖全局配置以启用 proxy_api_key（强制 cookie 鉴权）并模拟非 localhost
const config = loadConfig();
config.server.proxy_api_key = "testkey";
config.server.trust_proxy = true;
config.session.ttl_minutes = 60;

// 3. 构建 Hono 实例
const app = new Hono();
app.use("*", dashboardAuth);
app.route("/", createDashboardAuthRoutes());
app.route("/", createErrorLogRoutes());

// 4. 写入 16000 条大日志
const currentFile = resolve(tmpDataDir, "error-log.jsonl");
let currentContent = "";
const now = Date.now();
for (let i = 0; i < 16000; i++) {
  const ts = new Date(now - 100000 + i * 10).toISOString();
  currentContent += JSON.stringify({
    ts,
    version: "0.0.0-test",
    platform: "darwin",
    source: "main",
    error: { name: "CurrentError", message: `err ${i}`, stack: "at current.js:1" }
  }) + "\n";
}
writeFileSync(currentFile, currentContent, "utf-8");

// 5. 物理启动 TCP 服务，port:0 让 OS 分配空闲端口，避免 CI 端口冲突
const server = serve({ fetch: app.fetch, port: 0 }, async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 8082;
  const base = `http://127.0.0.1:${port}`;
  console.log(`E2E Test server is listening on port ${port}`);

  try {
    // 执行连续 3 轮完整端到端测试以证明全流程走通
    for (let round = 1; round <= 3; round++) {
      console.log(`\n--- Round ${round} E2E Test ---`);

      // 1) 登录并获得 Cookie _codex_session
      const loginRes = await fetch(`${base}/auth/dashboard-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.1.1.1" },
        body: JSON.stringify({ password: "testkey" }),
      });
      if (loginRes.status !== 200) {
        throw new Error(`Login failed with status ${loginRes.status}`);
      }
      const setCookie = loginRes.headers.get("Set-Cookie") || "";
      const cookieMatch = setCookie.match(/_codex_session=[^;]+/);
      if (!cookieMatch) throw new Error("Failed to extract _codex_session cookie");
      const cookie = cookieMatch[0];
      console.log(`Successfully logged in. Session cookie: ${cookie}`);

      // 2) 物理调用 count 获取未读数和总数 (预期 16000)
      const countStart = performance.now();
      const countRes = await fetch(`${base}/admin/error-logs/count`, {
        headers: { Cookie: cookie, "X-Forwarded-For": "1.1.1.1" },
      });
      const countEnd = performance.now();
      if (countRes.status !== 200) throw new Error(`Count request failed with status ${countRes.status}`);
      const countBody = await countRes.json() as { total: number; unread: number };
      console.log(`[Count Result] total: ${countBody.total}, unread: ${countBody.unread}, ms: ${(countEnd - countStart).toFixed(2)}`);
      if (countBody.total !== 16000 || countBody.unread !== 16000) {
        throw new Error(`Unexpected count body: ${JSON.stringify(countBody)}`);
      }

      // 3) 物理调用 seen 接口更新 cursor
      const seenStart = performance.now();
      const seenRes = await fetch(`${base}/admin/error-logs/seen`, {
        method: "POST",
        headers: { Cookie: cookie, "X-Forwarded-For": "1.1.1.1" },
      });
      const seenEnd = performance.now();
      if (seenRes.status !== 200) throw new Error(`Seen request failed with status ${seenRes.status}`);
      const seenBody = await seenRes.json() as { ok: boolean };
      console.log(`[Seen Result] ok: ${seenBody.ok}, ms: ${(seenEnd - seenStart).toFixed(2)}`);

      // 4) 再次物理调用 count 验证未读数变 0
      const afterRes = await fetch(`${base}/admin/error-logs/count`, {
        headers: { Cookie: cookie, "X-Forwarded-For": "1.1.1.1" },
      });
      if (afterRes.status !== 200) throw new Error(`After Count request failed with status ${afterRes.status}`);
      const afterBody = await afterRes.json() as { unread: number };
      console.log(`[After Count Result] unread: ${afterBody.unread}`);
      if (afterBody.unread !== 0) throw new Error(`Expected unread to be 0, got ${afterBody.unread}`);

      // 5) 清空日志
      const clearRes = await fetch(`${base}/admin/error-logs`, {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Forwarded-For": "1.1.1.1" },
      });
      if (clearRes.status !== 200) throw new Error(`Clear request failed with status ${clearRes.status}`);
      console.log("[Clear Result] Logs cleared successfully.");

      // 6) 重新写回 16000 条日志供下一轮测试使用
      writeFileSync(currentFile, currentContent, "utf-8");
    }

    console.log("\nE2E VERIFICATION COMPLETED SUCCESSFULLY!");
    console.log("All 3 rounds of Seen, Count, and Clear full flows completed successfully!");
  } catch (err) {
    console.error("E2E VERIFICATION FAILED:", err);
    process.exitCode = 1;
  } finally {
    server.close();
    rmSync(tmpDataDir, { recursive: true, force: true });
    process.exit();
  }
});
