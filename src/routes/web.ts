import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getConfig, getFingerprint } from "../config.js";
import { getUpdateState } from "../update-checker.js";

export function createWebRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  const publicDir = resolve(process.cwd(), "public");

  app.get("/", (c) => {
    try {
      if (accountPool.isAuthenticated()) {
        const html = readFileSync(resolve(publicDir, "dashboard.html"), "utf-8");
        return c.html(html);
      }
      const html = readFileSync(resolve(publicDir, "login.html"), "utf-8");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read HTML file: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>UI files not found. The API is still available at /v1/chat/completions</p>");
    }
  });

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const userInfo = accountPool.getUserInfo();
    const poolSummary = accountPool.getPoolSummary();
    return c.json({
      status: "ok",
      authenticated,
      user: authenticated ? userInfo : null,
      pool: poolSummary,
      update: getUpdateState(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    // Only allow in development or from localhost
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "";
    const isLocalhost = remoteAddr === "" || remoteAddr === "127.0.0.1" || remoteAddr === "::1";
    if (isProduction && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const config = getConfig();
    const fp = getFingerprint();

    const ua = fp.user_agent_template
      .replace("{version}", config.client.app_version)
      .replace("{platform}", config.client.platform)
      .replace("{arch}", config.client.arch);

    const promptsDir = resolve(process.cwd(), "config/prompts");
    const prompts: Record<string, boolean> = {
      "desktop-context.md": existsSync(resolve(promptsDir, "desktop-context.md")),
      "title-generation.md": existsSync(resolve(promptsDir, "title-generation.md")),
      "pr-generation.md": existsSync(resolve(promptsDir, "pr-generation.md")),
      "automation-response.md": existsSync(resolve(promptsDir, "automation-response.md")),
    };

    // Check for update state
    let updateState = null;
    const statePath = resolve(process.cwd(), "data/update-state.json");
    if (existsSync(statePath)) {
      try {
        updateState = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    return c.json({
      headers: {
        "User-Agent": ua,
        originator: config.client.originator,
      },
      client: {
        app_version: config.client.app_version,
        build_number: config.client.build_number,
        platform: config.client.platform,
        arch: config.client.arch,
      },
      api: {
        base_url: config.api.base_url,
      },
      model: {
        default: config.model.default,
      },
      codex_fields: {
        developer_instructions: "loaded from config/prompts/desktop-context.md",
        approval_policy: "never",
        sandbox: "workspace-write",
        personality: null,
        ephemeral: null,
      },
      prompts_loaded: prompts,
      update_state: updateState,
    });
  });

  return app;
}
