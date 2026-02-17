import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, loadFingerprint, getConfig } from "./config.js";
import { AccountPool } from "./auth/account-pool.js";
import { RefreshScheduler } from "./auth/refresh-scheduler.js";
import { SessionManager } from "./session/manager.js";
import { logger } from "./middleware/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAccountRoutes } from "./routes/accounts.js";
import { createChatRoutes } from "./routes/chat.js";
import modelsApp from "./routes/models.js";
import { createWebRoutes } from "./routes/web.js";
import { CookieJar } from "./proxy/cookie-jar.js";

async function main() {
  // Load configuration
  console.log("[Init] Loading configuration...");
  const config = loadConfig();
  loadFingerprint();

  // Initialize managers
  const accountPool = new AccountPool();
  const refreshScheduler = new RefreshScheduler(accountPool);
  const sessionManager = new SessionManager();
  const cookieJar = new CookieJar();

  // Create Hono app
  const app = new Hono();

  // Global middleware
  app.use("*", logger);
  app.use("*", errorHandler);

  // Mount routes
  const authRoutes = createAuthRoutes(accountPool);
  const accountRoutes = createAccountRoutes(accountPool, refreshScheduler, cookieJar);
  const chatRoutes = createChatRoutes(accountPool, sessionManager, cookieJar);
  const webRoutes = createWebRoutes(accountPool);

  app.route("/", authRoutes);
  app.route("/", accountRoutes);
  app.route("/", chatRoutes);
  app.route("/", modelsApp);
  app.route("/", webRoutes);

  // Start server
  const port = config.server.port;
  const host = config.server.host;

  const poolSummary = accountPool.getPoolSummary();

  console.log(`
╔══════════════════════════════════════════╗
║           Codex Proxy Server             ║
╠══════════════════════════════════════════╣
║  Status: ${accountPool.isAuthenticated() ? "Authenticated ✓" : "Not logged in  "}             ║
║  Listen: http://${host}:${port}              ║
║  API:    http://${host}:${port}/v1            ║
╚══════════════════════════════════════════╝
`);

  if (accountPool.isAuthenticated()) {
    const user = accountPool.getUserInfo();
    console.log(`  User: ${user?.email ?? "unknown"}`);
    console.log(`  Plan: ${user?.planType ?? "unknown"}`);
    console.log(`  Key:  ${accountPool.getProxyApiKey()}`);
    console.log(`  Pool: ${poolSummary.active} active / ${poolSummary.total} total accounts`);
  } else {
    console.log(`  Open http://localhost:${port} to login`);
  }
  console.log();

  serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Shutdown] Cleaning up...");
    cookieJar.destroy();
    refreshScheduler.destroy();
    accountPool.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
