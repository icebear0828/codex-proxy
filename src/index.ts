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
import { initTransport } from "./tls/transport.js";

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

  // Initialize TLS transport (auto-selects curl CLI or libcurl FFI)
  await initTransport();

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
  const displayHost = (host === "0.0.0.0" || host === "::") ? "localhost" : host;

  console.log(`
╔══════════════════════════════════════════╗
║           Codex Proxy Server             ║
╠══════════════════════════════════════════╣
║  Status: ${accountPool.isAuthenticated() ? "Authenticated ✓" : "Not logged in  "}             ║
║  Listen: http://${displayHost}:${port}              ║
║  API:    http://${displayHost}:${port}/v1            ║
╚══════════════════════════════════════════╝
`);

  if (accountPool.isAuthenticated()) {
    const user = accountPool.getUserInfo();
    console.log(`  User: ${user?.email ?? "unknown"}`);
    console.log(`  Plan: ${user?.planType ?? "unknown"}`);
    console.log(`  Key:  ${accountPool.getProxyApiKey()}`);
    console.log(`  Pool: ${poolSummary.active} active / ${poolSummary.total} total accounts`);
  } else {
    console.log(`  Open http://${displayHost}:${port} to login`);
  }
  console.log();

  // Start background update checker
  startUpdateChecker();

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // P1-7: Graceful shutdown — stop accepting, drain, then cleanup
  let shutdownCalled = false;
  const DRAIN_TIMEOUT_MS = 5_000;
  const shutdown = () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    console.log("\n[Shutdown] Stopping new connections...");

    const forceExit = setTimeout(() => {
      console.error("[Shutdown] Timeout after 10s — forcing exit");
      process.exit(1);
    }, 10_000);
    if (forceExit.unref) forceExit.unref();

    // 1. Stop accepting new connections
    server.close(() => {
      console.log("[Shutdown] Server closed, cleaning up resources...");
      cleanup();
    });

    // 2. Grace period for active streams, then force cleanup
    setTimeout(() => {
      console.log("[Shutdown] Drain timeout reached, cleaning up...");
      cleanup();
    }, DRAIN_TIMEOUT_MS);

    let cleanupDone = false;
    function cleanup() {
      if (cleanupDone) return;
      cleanupDone = true;
      try {
        stopUpdateChecker();
        refreshScheduler.destroy();
        sessionManager.destroy();
        cookieJar.destroy();
        accountPool.destroy();
      } catch (err) {
        console.error("[Shutdown] Error during cleanup:", err instanceof Error ? err.message : err);
      }
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  // Trigger graceful shutdown instead of hard exit
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(1), 2000).unref();
});
