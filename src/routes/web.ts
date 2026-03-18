import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getPublicDir, getDesktopPublicDir } from "../paths.js";
import { createHealthRoutes } from "./admin/health.js";
import { createUpdateRoutes } from "./admin/update.js";
import { createConnectionRoutes } from "./admin/connection.js";
import { createSettingsRoutes } from "./admin/settings.js";

export function createWebRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  const publicDir = getPublicDir();
  const desktopPublicDir = getDesktopPublicDir();

  const desktopIndexPath = resolve(desktopPublicDir, "index.html");
  const webIndexPath = resolve(publicDir, "index.html");
  const hasDesktopUI = existsSync(desktopIndexPath);
  const hasWebUI = existsSync(webIndexPath);

  console.log(`[Web] publicDir: ${publicDir} (exists: ${hasWebUI})`);
  console.log(`[Web] desktopPublicDir: ${desktopPublicDir} (exists: ${hasDesktopUI})`);

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

  // Desktop UI — served at /desktop for Electron
  if (hasDesktopUI) {
    app.use("/desktop/assets/*", async (c, next) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      await next();
    }, serveStatic({
      root: desktopPublicDir,
      rewriteRequestPath: (path) => path.replace(/^\/desktop/, ""),
    }));

    app.get("/desktop", (c) => {
      const html = readFileSync(desktopIndexPath, "utf-8");
      c.header("Cache-Control", "no-cache");
      return c.html(html);
    });
  } else {
    app.get("/desktop", (c) => {
      console.warn(`[Web] Desktop UI not found at ${desktopIndexPath}, falling back to web UI`);
      return c.redirect("/");
    });
  }

  // Mount admin subroutes
  app.route("/", createHealthRoutes(accountPool));
  app.route("/", createUpdateRoutes());
  app.route("/", createConnectionRoutes(accountPool));
  app.route("/", createSettingsRoutes());

  return app;
}
