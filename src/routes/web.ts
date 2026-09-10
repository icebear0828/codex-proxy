import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getPublicDir } from "../paths.js";
import { createHealthRoutes } from "./admin/health.js";
import { createUpdateRoutes } from "./admin/update.js";
import { createConnectionRoutes } from "./admin/connection.js";
import { createSettingsRoutes } from "./admin/settings.js";
import { createOllamaAdminRoutes } from "./admin/ollama.js";
import { createUsageStatsRoutes } from "./admin/usage-stats.js";
import { createLogRoutes } from "./admin/logs.js";
import { createErrorLogRoutes } from "./admin/error-logs.js";
import { createClientKeyAdminRoutes } from "./admin/client-keys.js";
import { getConfig } from "../config.js";
import type { UsageStatsStore } from "../auth/usage-stats.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";

export function createWebRoutes(
  accountPool: AccountPool,
  usageStats: UsageStatsStore,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();

  // The v2 API was removed, but old clients still probe these endpoints.
  // Return an actionable response so migrations are distinguishable from
  // unknown routes and avoid treating the probes as server failures.
  const legacyApiRemoved = () =>
    new Response(
      JSON.stringify({
        error: "legacy_api_removed",
        message: "The /api/v2 API was removed. Use the current API endpoints.",
      }),
      { status: 410, headers: { "Content-Type": "application/json" } },
    );
  app.all("/api/v2/auth/login", legacyApiRemoved);
  app.all("/api/v2/app/version", legacyApiRemoved);

  const publicDir = getPublicDir();

  const webIndexPath = resolve(publicDir, "index.html");
  const hasWebUI = existsSync(webIndexPath);

  console.log(`[Web] publicDir: ${publicDir} (exists: ${hasWebUI})`);

  // Serve Vite build assets (web) — immutable cache (filenames contain content hash)
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  }, serveStatic({ root: publicDir }));

  // Vite copies web/public/ (brand icon + favicon) to the build-output root;
  // they are not content-hashed, so they do not fall under /assets/*. Serve
  // them explicitly here, otherwise GET /icon.png (and /favicon.ico) 404s in
  // production builds — dev works only because the Vite dev server serves
  // web/public/ directly.
  // NOTE: use an explicit file handler rather than serveStatic — mounted on an
  // exact path serveStatic cannot derive the relative file and always 404s.
  const servePublicFile = (file: string, contentType: string) => (c: Context): Response | Promise<Response> => {
    const filePath = resolve(publicDir, file);
    if (!existsSync(filePath)) return c.notFound();
    const data = readFileSync(filePath);
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  };

  app.get("/icon.png", servePublicFile("icon.png", "image/png"));
  app.get("/favicon.ico", servePublicFile("favicon.ico", "image/x-icon"));

  app.get("/", (c) => {
    try {
      const html = readFileSync(webIndexPath, "utf-8");
      c.header("Cache-Control", "no-cache");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read HTML file: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>UI files not found. Run 'npm run build:web' first. The API is still available at /v1/chat/completions</p>");
    }
  });

  // Mount admin subroutes
  app.route("/", createHealthRoutes(accountPool));
  app.route("/", createUpdateRoutes());
  app.route("/", createConnectionRoutes(accountPool));
  app.route("/", createSettingsRoutes(accountPool));
  app.route("/", createOllamaAdminRoutes());
  app.route("/", createUsageStatsRoutes(accountPool, usageStats));
  app.route("/", createLogRoutes());
  app.route("/", createErrorLogRoutes());
  if (clientKeyPool) {
    app.route(
      "/",
      createClientKeyAdminRoutes(
        clientKeyPool,
        () => getConfig().server.proxy_api_key ?? accountPool.getProxyApiKey() ?? null,
      ),
    );
  }

  return app;
}
