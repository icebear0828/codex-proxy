import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, loadFingerprint, getConfig, hasLocalOverride } from "./config.js";
import { initContext } from "./context.js";
import { AccountPool } from "./auth/account-pool.js";
import { RefreshScheduler } from "./auth/refresh-scheduler.js";

import { requestId } from "./middleware/request-id.js";
import { logger } from "./middleware/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { dashboardAuth } from "./middleware/dashboard-auth.js";
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
import { startProxyUpdateChecker, stopProxyUpdateChecker, setCloseHandler, getDeployMode } from "./self-update.js";
import { initProxy } from "./tls/proxy.js";
import { cleanupStaleLocks } from "./auth/refresh-lock.js";
import { initTransport, getTransport } from "./tls/transport.js";
import { loadStaticModels } from "./models/model-store.js";
import { startModelRefresh, stopModelRefresh } from "./models/model-fetcher.js";
import { startQuotaRefresh, stopQuotaRefresh } from "./auth/usage-refresher.js";
import { UsageStatsStore } from "./auth/usage-stats.js";
import { startSessionCleanup, stopSessionCleanup } from "./auth/dashboard-session.js";
import { createDashboardAuthRoutes } from "./routes/dashboard-login.js";
import { UpstreamRouter } from "./proxy/upstream-router.js";
import { OpenAIUpstream } from "./proxy/openai-upstream.js";
import { AnthropicUpstream } from "./proxy/anthropic-upstream.js";
import { GeminiUpstream } from "./proxy/gemini-upstream.js";
import type { UpstreamAdapter } from "./proxy/upstream-adapter.js";

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
  const fingerprint = loadFingerprint();

  // Load static model catalog (before transport/auth init)
  loadStaticModels();

  // Detect proxy (config > env > auto-detect local ports)
  await initProxy();

  // Initialize TLS transport (auto-selects curl CLI or libcurl FFI)
  const transport = await initTransport();
  initContext(config, fingerprint, transport);

  // Clean up stale refresh locks from previous crashes
  cleanupStaleLocks();

  // Initialize managers
  const accountPool = new AccountPool();
  const refreshScheduler = new RefreshScheduler(accountPool);
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  refreshScheduler.setProxyPool(proxyPool);

  // Create Hono app
  const app = new Hono();

  // Global middleware
  app.use("*", requestId);
  app.use("*", logger);
  app.use("*", errorHandler);
  app.use("*", dashboardAuth);

  // Build upstream router from config
  const cfg = getConfig();
  const adapters = new Map<string, UpstreamAdapter>();
  if (cfg.providers.openai) {
    adapters.set(
      "openai",
      new OpenAIUpstream("openai", cfg.providers.openai.api_key, cfg.providers.openai.base_url),
    );
    console.log("[Init] OpenAI upstream configured");
  }
  if (cfg.providers.anthropic) {
    adapters.set("anthropic", new AnthropicUpstream(cfg.providers.anthropic.api_key));
    console.log("[Init] Anthropic upstream configured");
  }
  if (cfg.providers.gemini) {
    adapters.set("gemini", new GeminiUpstream(cfg.providers.gemini.api_key));
    console.log("[Init] Gemini upstream configured");
  }
  for (const [name, provider] of Object.entries(cfg.providers.custom)) {
    adapters.set(name, new OpenAIUpstream(name, provider.api_key, provider.base_url));
    console.log(`[Init] Custom upstream "${name}" configured (${provider.base_url})`);
    for (const model of provider.models) {
      if (!cfg.model_routing[model]) {
        cfg.model_routing[model] = name;
      }
    }
  }
  const upstreamRouter = adapters.size > 0
    ? new UpstreamRouter(adapters, cfg.model_routing, "codex")
    : undefined;

  // Mount routes
  const authRoutes = createAuthRoutes(accountPool, refreshScheduler);
  const accountRoutes = createAccountRoutes(accountPool, refreshScheduler, cookieJar, proxyPool);
  const chatRoutes = createChatRoutes(accountPool, cookieJar, proxyPool, upstreamRouter);
  const messagesRoutes = createMessagesRoutes(accountPool, cookieJar, proxyPool, upstreamRouter);
  const geminiRoutes = createGeminiRoutes(accountPool, cookieJar, proxyPool, upstreamRouter);
  const responsesRoutes = createResponsesRoutes(accountPool, cookieJar, proxyPool, upstreamRouter);
  const proxyRoutes = createProxyRoutes(proxyPool, accountPool);
  const usageStats = new UsageStatsStore();
  usageStats.recoverBaseline(accountPool);
  const webRoutes = createWebRoutes(accountPool, usageStats);

  app.route("/", createDashboardAuthRoutes());
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
  // User's explicit local.yaml host wins over programmatic options (e.g. Electron's 127.0.0.1 default)
  const port = options?.port ?? config.server.port;
  const host = hasLocalOverride("server", "host")
    ? config.server.host
    : (options?.host ?? config.server.host);

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

  // Start dashboard session cleanup
  startSessionCleanup();

  // Start background update checkers
  // (Electron has its own native auto-updater — skip proxy update checker)
  startUpdateChecker();
  if (getDeployMode() !== "electron") {
    startProxyUpdateChecker();
  }

  // Start background model refresh (requires auth to be ready)
  startModelRefresh(accountPool, cookieJar, proxyPool);

  // Start usage stats snapshot timer (no upstream requests — quota is collected passively)
  startQuotaRefresh(accountPool, usageStats);

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
        stopQuotaRefresh();
        stopSessionCleanup();
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
      getTransport().destroy?.();
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
