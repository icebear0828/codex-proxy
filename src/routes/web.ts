import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getConfig, getFingerprint, reloadAllConfigs } from "../config.js";
import { getPublicDir, getDesktopPublicDir, getConfigDir, getDataDir, getBinDir, isEmbedded } from "../paths.js";
import { getTransport, getTransportInfo } from "../tls/transport.js";
import { getCurlDiagnostics } from "../tls/curl-binary.js";
import { buildHeaders } from "../fingerprint/manager.js";
import { getUpdateState, checkForUpdate, isUpdateInProgress } from "../update-checker.js";
import { getProxyInfo, canSelfUpdate, checkProxySelfUpdate, applyProxySelfUpdate, isProxyUpdateInProgress, getCachedProxyUpdateResult, getDeployMode } from "../self-update.js";
import { mutateYaml } from "../utils/yaml-mutate.js";

export function createWebRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  const publicDir = getPublicDir();
  const desktopPublicDir = getDesktopPublicDir();

  // Serve Vite build assets (web)
  app.use("/assets/*", serveStatic({ root: publicDir }));

  app.get("/", (c) => {
    try {
      const html = readFileSync(resolve(publicDir, "index.html"), "utf-8");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read HTML file: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>UI files not found. Run 'npm/pnpm/bun run build:web' first. The API is still available at /v1/chat/completions</p>");
    }
  });

  // Desktop UI — served at /desktop for Electron
  // Vite builds with base: "/desktop/" so request paths are /desktop/assets/...
  // but files live at public-desktop/assets/..., so strip the /desktop prefix
  app.use("/desktop/assets/*", serveStatic({
    root: desktopPublicDir,
    rewriteRequestPath: (path) => path.replace(/^\/desktop/, ""),
  }));

  app.get("/desktop", (c) => {
    try {
      const html = readFileSync(resolve(desktopPublicDir, "index.html"), "utf-8");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read desktop HTML: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>Desktop UI files not found. Run 'npm run build:desktop' first.</p>");
    }
  });

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const poolSummary = accountPool.getPoolSummary();
    return c.json({
      status: "ok",
      authenticated,
      pool: { total: poolSummary.total, active: poolSummary.active },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    // Only allow in development or from localhost
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = remoteAddr === "" || remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
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

    const promptsDir = resolve(getConfigDir(), "prompts");
    const prompts: Record<string, boolean> = {
      "desktop-context.md": existsSync(resolve(promptsDir, "desktop-context.md")),
      "title-generation.md": existsSync(resolve(promptsDir, "title-generation.md")),
      "pr-generation.md": existsSync(resolve(promptsDir, "pr-generation.md")),
      "automation-response.md": existsSync(resolve(promptsDir, "automation-response.md")),
    };

    // Check for update state
    let updateState = null;
    const statePath = resolve(getDataDir(), "update-state.json");
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

  app.get("/debug/diagnostics", (c) => {
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = remoteAddr === "" || remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
    if (process.env.NODE_ENV === "production" && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const transport = getTransportInfo();
    const curl = getCurlDiagnostics();
    const poolSummary = accountPool.getPoolSummary();
    const caCertPath = resolve(getBinDir(), "cacert.pem");

    return c.json({
      transport: {
        type: transport.type,
        initialized: transport.initialized,
        impersonate: transport.impersonate,
        ffi_error: transport.ffi_error,
      },
      curl: {
        binary: curl.binary,
        is_impersonate: curl.is_impersonate,
        profile: curl.profile,
      },
      proxy: { url: curl.proxy_url },
      ca_cert: { found: existsSync(caCertPath), path: caCertPath },
      accounts: {
        total: poolSummary.total,
        active: poolSummary.active,
        authenticated: accountPool.isAuthenticated(),
      },
      paths: {
        bin: getBinDir(),
        config: getConfigDir(),
        data: getDataDir(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        embedded: isEmbedded(),
      },
    });
  });

  // --- Update management endpoints ---

  app.get("/admin/update-status", (c) => {
    const proxyInfo = getProxyInfo();
    const codexState = getUpdateState();
    const cached = getCachedProxyUpdateResult();

    return c.json({
      proxy: {
        version: proxyInfo.version,
        commit: proxyInfo.commit,
        can_self_update: canSelfUpdate(),
        mode: getDeployMode(),
        commits_behind: cached?.commitsBehind ?? null,
        commits: cached?.commits ?? [],
        release: cached?.release ? { version: cached.release.version, body: cached.release.body, url: cached.release.url } : null,
        update_available: cached?.updateAvailable ?? false,
        update_in_progress: isProxyUpdateInProgress(),
      },
      codex: {
        current_version: codexState?.current_version ?? null,
        current_build: codexState?.current_build ?? null,
        latest_version: codexState?.latest_version ?? null,
        latest_build: codexState?.latest_build ?? null,
        update_available: codexState?.update_available ?? false,
        update_in_progress: isUpdateInProgress(),
        last_check: codexState?.last_check ?? null,
      },
    });
  });

  app.post("/admin/check-update", async (c) => {
    const results: {
      proxy?: {
        commits_behind: number;
        current_commit: string | null;
        latest_commit: string | null;
        commits: Array<{ hash: string; message: string }>;
        release: { version: string; body: string; url: string } | null;
        update_available: boolean;
        mode: string;
        error?: string;
      };
      codex?: { update_available: boolean; current_version: string; latest_version: string | null; version_changed?: boolean; error?: string };
    } = {};

    // 1. Proxy update check (all modes)
    try {
      const proxyResult = await checkProxySelfUpdate();
      results.proxy = {
        commits_behind: proxyResult.commitsBehind,
        current_commit: proxyResult.currentCommit,
        latest_commit: proxyResult.latestCommit,
        commits: proxyResult.commits,
        release: proxyResult.release ? { version: proxyResult.release.version, body: proxyResult.release.body, url: proxyResult.release.url } : null,
        update_available: proxyResult.updateAvailable,
        mode: proxyResult.mode,
      };
    } catch (err) {
      results.proxy = {
        commits_behind: 0,
        current_commit: null,
        latest_commit: null,
        commits: [],
        release: null,
        update_available: false,
        mode: getDeployMode(),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Codex fingerprint check
    if (!isEmbedded()) {
      try {
        const prevVersion = getUpdateState()?.current_version ?? null;
        const codexState = await checkForUpdate();
        results.codex = {
          update_available: codexState.update_available,
          current_version: codexState.current_version,
          latest_version: codexState.latest_version,
          version_changed: prevVersion !== null && codexState.current_version !== prevVersion,
        };
      } catch (err) {
        results.codex = {
          update_available: false,
          current_version: "unknown",
          latest_version: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return c.json({
      ...results,
      proxy_update_in_progress: isProxyUpdateInProgress(),
      codex_update_in_progress: isUpdateInProgress(),
    });
  });

  app.post("/admin/apply-update", async (c) => {
    if (!canSelfUpdate()) {
      c.status(400);
      return c.json({ started: false, error: "Self-update not available in this deploy mode" });
    }
    const result = await applyProxySelfUpdate();
    return c.json(result);
  });

  // --- Test connection endpoint ---

  app.post("/admin/test-connection", async (c) => {
    type DiagStatus = "pass" | "fail" | "skip";
    interface DiagCheck { name: string; status: DiagStatus; latencyMs: number; detail: string | null; error: string | null; }
    const checks: DiagCheck[] = [];
    let overallFailed = false;

    // 1. Server check — if we're responding, it's a pass
    const serverStart = Date.now();
    checks.push({
      name: "server",
      status: "pass",
      latencyMs: Date.now() - serverStart,
      detail: `PID ${process.pid}`,
      error: null,
    });

    // 2. Accounts check — any authenticated accounts?
    const accountsStart = Date.now();
    const poolSummary = accountPool.getPoolSummary();
    const hasActive = poolSummary.active > 0;
    checks.push({
      name: "accounts",
      status: hasActive ? "pass" : "fail",
      latencyMs: Date.now() - accountsStart,
      detail: hasActive
        ? `${poolSummary.active} active / ${poolSummary.total} total`
        : `0 active / ${poolSummary.total} total`,
      error: hasActive ? null : "No active accounts",
    });
    if (!hasActive) overallFailed = true;

    // 3. Transport check — TLS transport initialized?
    const transportStart = Date.now();
    const transportInfo = getTransportInfo();
    const caCertPath = resolve(getBinDir(), "cacert.pem");
    const caCertExists = existsSync(caCertPath);
    const transportOk = transportInfo.initialized;
    checks.push({
      name: "transport",
      status: transportOk ? "pass" : "fail",
      latencyMs: Date.now() - transportStart,
      detail: transportOk
        ? `${transportInfo.type}, impersonate=${transportInfo.impersonate}, ca_cert=${caCertExists}`
        : null,
      error: transportOk
        ? (transportInfo.ffi_error ? `FFI fallback: ${transportInfo.ffi_error}` : null)
        : (transportInfo.ffi_error ?? "Transport not initialized"),
    });
    if (!transportOk) overallFailed = true;

    // 4. Upstream check — can we reach chatgpt.com?
    if (!hasActive) {
      // Skip upstream if no accounts
      checks.push({
        name: "upstream",
        status: "skip",
        latencyMs: 0,
        detail: "Skipped (no active accounts)",
        error: null,
      });
    } else {
      const upstreamStart = Date.now();
      const acquired = accountPool.acquire();
      if (!acquired) {
        checks.push({
          name: "upstream",
          status: "fail",
          latencyMs: Date.now() - upstreamStart,
          detail: null,
          error: "Could not acquire account for test",
        });
        overallFailed = true;
      } else {
        try {
          const transport = getTransport();
          const config = getConfig();
          const url = `${config.api.base_url}/codex/usage`;
          const headers = buildHeaders(acquired.token, acquired.accountId);
          const resp = await transport.get(url, headers, 15);
          const latency = Date.now() - upstreamStart;
          if (resp.status >= 200 && resp.status < 400) {
            checks.push({
              name: "upstream",
              status: "pass",
              latencyMs: latency,
              detail: `HTTP ${resp.status} (${latency}ms)`,
              error: null,
            });
          } else {
            checks.push({
              name: "upstream",
              status: "fail",
              latencyMs: latency,
              detail: `HTTP ${resp.status}`,
              error: `Upstream returned ${resp.status}`,
            });
            overallFailed = true;
          }
        } catch (err) {
          const latency = Date.now() - upstreamStart;
          checks.push({
            name: "upstream",
            status: "fail",
            latencyMs: latency,
            detail: null,
            error: err instanceof Error ? err.message : String(err),
          });
          overallFailed = true;
        } finally {
          accountPool.releaseWithoutCounting(acquired.entryId);
        }
      }
    }

    return c.json({
      checks,
      overall: overallFailed ? "fail" as const : "pass" as const,
      timestamp: new Date().toISOString(),
    });
  });

  // --- Settings endpoints ---

  app.get("/admin/settings", (c) => {
    const config = getConfig();
    return c.json({ proxy_api_key: config.server.proxy_api_key });
  });

  app.post("/admin/settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    // Auth: if a key is currently set, require Bearer token matching it
    if (currentKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== currentKey) {
        c.status(401);
        return c.json({ error: "Invalid current API key" });
      }
    }

    const body = await c.req.json() as { proxy_api_key?: string | null };
    const newKey = body.proxy_api_key === undefined ? currentKey : (body.proxy_api_key || null);

    const configPath = resolve(getConfigDir(), "default.yaml");
    mutateYaml(configPath, (data) => {
      const server = data.server as Record<string, unknown>;
      server.proxy_api_key = newKey;
    });
    reloadAllConfigs();

    return c.json({ success: true, proxy_api_key: newKey });
  });

  return app;
}
