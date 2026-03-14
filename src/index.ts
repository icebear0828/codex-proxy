import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, loadFingerprint, getConfig } from "./config.js";
import { AccountPool } from "./auth/account-pool.js";
import { RefreshScheduler } from "./auth/refresh-scheduler.js";

import { requestId } from "./middleware/request-id.js";
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
import { ProxyPool } from "./proxy/proxy-pool.js";
import { createProxyRoutes } from "./routes/proxies.js";
import { createResponsesRoutes } from "./routes/responses.js";
import { startUpdateChecker, stopUpdateChecker } from "./update-checker.js";
import { startProxyUpdateChecker, stopProxyUpdateChecker, setCloseHandler } from "./self-update.js";
import { initProxy } from "./tls/curl-binary.js";
import { initTransport } from "./tls/transport.js";
import { loadStaticModels } from "./models/model-store.js";
import { startModelRefresh, stopModelRefresh } from "./models/model-fetcher.js";

export interface ServerHandle {
  close: () => Promise<void>;
  port: number;
}

export interface StartOptions {
  host?: string;
  port?: number;
}

/**
 * Core startup logic shared by CLI and Electron entry points.
 * Throws on config errors instead of calling process.exit().
 */
export async function startServer(options?: StartOptions): Promise<ServerHandle> {
  // Load configuration
  console.log("[Init] Loading configuration...");
  const config = loadConfig();
  loadFingerprint();

  // Load static model catalog (before transport/auth init)
  loadStaticModels();

  // Detect proxy (config > env > auto-detect local ports)
  await initProxy();

  // Initialize TLS transport (auto-selects curl CLI or libcurl FFI)
  await initTransport();

  // Initialize managers
  const accountPool = new AccountPool();
  const refreshScheduler = new RefreshScheduler(accountPool);
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();

  // Create Hono app
  const app = new Hono();

  // Global middleware
  app.use("*", requestId);
  app.use("*", logger);
  app.use("*", errorHandler);

  // Mount routes
  const authRoutes = createAuthRoutes(accountPool, refreshScheduler);
  const accountRoutes = createAccountRoutes(accountPool, refreshScheduler, cookieJar, proxyPool);
  const chatRoutes = createChatRoutes(accountPool, cookieJar, proxyPool);
  const messagesRoutes = createMessagesRoutes(accountPool, cookieJar, proxyPool);
  const geminiRoutes = createGeminiRoutes(accountPool, cookieJar, proxyPool);
  const responsesRoutes = createResponsesRoutes(accountPool, cookieJar, proxyPool);
  const proxyRoutes = createProxyRoutes(proxyPool, accountPool);
  const webRoutes = createWebRoutes(accountPool);

  app.route("/", authRoutes);
  app.route("/", accountRoutes);
  app.route("/", chatRoutes);
  app.route("/", messagesRoutes);
  app.route("/", geminiRoutes);
  app.route("/", responsesRoutes);
  app.route("/", proxyRoutes);
  app.route("/", createModelRoutes());
  app.route("/", webRoutes);

  // Start server
  const port = options?.port ?? config.server.port;
  const host = options?.host ?? config.server.host;

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
    console.log(`  Key:  ${config.server.proxy_api_key ?? accountPool.getProxyApiKey()}`);
    console.log(`  Pool: ${poolSummary.active} active / ${poolSummary.total} total accounts`);
  } else {
    console.log(`  Open http://${displayHost}:${port} to login`);
  }
  console.log();

  // Start background update checker
  startUpdateChecker();
  startProxyUpdateChecker();

  // Start background model refresh (requires auth to be ready)
  startModelRefresh(accountPool, cookieJar, proxyPool);

  // Start proxy health check timer (if proxies exist)
  proxyPool.startHealthCheckTimer();

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // Resolve actual port (may differ from requested when port=0)
  const addr = server.address();
  const actualPort = (addr && typeof addr === "object") ? addr.port : port;

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      server.close(() => {
        stopUpdateChecker();
        stopProxyUpdateChecker();
        stopModelRefresh();
        refreshScheduler.destroy();
        proxyPool.destroy();
        cookieJar.destroy();
        accountPool.destroy();
        resolve();
      });
    });
  };

  // Register close handler so self-update can attempt graceful shutdown before restart
  setCloseHandler(close);

  return { close, port: actualPort };
}

// ── CLI entry point ──────────────────────────────────────────────────

async function main() {
  let handle: ServerHandle;

  // Retry on EADDRINUSE — the previous process may still be releasing the port after a self-update restart
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      handle = await startServer();
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < MAX_RETRIES) {
        console.warn(`[Init] Port in use, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Init] Failed to start server: ${msg}`);
      console.error("[Init] Make sure config/default.yaml and config/fingerprint.yaml exist and are valid YAML.");
      process.exit(1);
    }
  }

  // P1-7: Graceful shutdown — stop accepting, drain, then cleanup
  let shutdownCalled = false;
  const shutdown = () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    console.log("\n[Shutdown] Stopping new connections...");

    const forceExit = setTimeout(() => {
      console.error("[Shutdown] Timeout after 10s — forcing exit");
      process.exit(1);
    }, 10_000);
    if (forceExit.unref) forceExit.unref();

    handle.close().then(() => {
      console.log("[Shutdown] Server closed, cleanup complete.");
      clearTimeout(forceExit);
      process.exit(0);
    }).catch((err) => {
      console.error("[Shutdown] Error during cleanup:", err instanceof Error ? err.message : err);
      clearTimeout(forceExit);
      process.exit(1);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run CLI entry when executed directly (not imported by Electron)
const isDirectRun = process.argv[1]?.includes("index");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
