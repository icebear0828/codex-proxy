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
import { createMessagesRoutes } from "./routes/messages.js";
import { createGeminiRoutes } from "./routes/gemini.js";
import { createModelRoutes } from "./routes/models.js";
import { createWebRoutes } from "./routes/web.js";
import { CookieJar } from "./proxy/cookie-jar.js";
import { startUpdateChecker, stopUpdateChecker } from "./update-checker.js";
import { initProxy } from "./tls/curl-binary.js";

async function main() {
  // Load configuration
  console.log("[Init] Loading configuration...");
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    loadFingerprint();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Init] Failed to load configuration: ${msg}`);
    console.error("[Init] Make sure config/default.yaml and config/fingerprint.yaml exist and are valid YAML.");
    process.exit(1);
  }

  // Detect proxy (config > env > auto-detect local ports)
  await initProxy();

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
  const authRoutes = createAuthRoutes(accountPool, refreshScheduler);
  const accountRoutes = createAccountRoutes(accountPool, refreshScheduler, cookieJar);
  const chatRoutes = createChatRoutes(accountPool, sessionManager, cookieJar);
  const messagesRoutes = createMessagesRoutes(accountPool, sessionManager, cookieJar);
  const geminiRoutes = createGeminiRoutes(accountPool, sessionManager, cookieJar);
  const webRoutes = createWebRoutes(accountPool);

  app.route("/", authRoutes);
  app.route("/", accountRoutes);
  app.route("/", chatRoutes);
  app.route("/", messagesRoutes);
  app.route("/", geminiRoutes);
  app.route("/", createModelRoutes());
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
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`  Open http://${displayHost}:${port} to login`);
  }
  console.log();

  // Start background update checker
  startUpdateChecker();

  serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // Graceful shutdown with timeout protection
  let shutdownCalled = false;
  const shutdown = () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    console.log("\n[Shutdown] Cleaning up...");
    const forceExit = setTimeout(() => {
      console.error("[Shutdown] Timeout after 10s — forcing exit");
      process.exit(1);
    }, 10_000);
    if (forceExit.unref) forceExit.unref();

    try {
      stopUpdateChecker();
      refreshScheduler.destroy();  // Cancel timers first
      sessionManager.destroy();
      cookieJar.destroy();         // Flush cookies
      accountPool.destroy();       // Flush accounts
    } catch (err) {
      console.error("[Shutdown] Error during cleanup:", err instanceof Error ? err.message : err);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
