import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getPublicDir } from "../paths.js";
import { createHealthRoutes } from "./admin/health.js";
import { createUpdateRoutes } from "./admin/update.js";
import { createConnectionRoutes } from "./admin/connection.js";
import { createSettingsRoutes } from "./admin/settings.js";
import { createUsageStatsRoutes } from "./admin/usage-stats.js";
import type { UsageStatsStore } from "../auth/usage-stats.js";

export function createWebRoutes(accountPool: AccountPool, usageStats: UsageStatsStore): Hono {
  const app = new Hono();

  const publicDir = getPublicDir();

  const webIndexPath = resolve(publicDir, "index.html");
  const hasWebUI = existsSync(webIndexPath);

  console.log(`[Web] publicDir: ${publicDir} (exists: ${hasWebUI})`);

  // Serve Vite build assets (web) — immutable cache (filenames contain content hash)
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  }, serveStatic({ root: publicDir }));

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
  app.route("/", createSettingsRoutes());
  app.route("/", createUsageStatsRoutes(accountPool, usageStats));

  return app;
}
