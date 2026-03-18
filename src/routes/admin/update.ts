import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getUpdateState, checkForUpdate, isUpdateInProgress } from "../../update-checker.js";
import { getProxyInfo, canSelfUpdate, checkProxySelfUpdate, applyProxySelfUpdate, isProxyUpdateInProgress, getCachedProxyUpdateResult, getDeployMode } from "../../self-update.js";
import { isEmbedded } from "../../paths.js";

export function createUpdateRoutes(): Hono {
  const app = new Hono();

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
      const mode = getDeployMode();
      c.status(400);
      return c.json({
        started: false,
        error: "Self-update not available in this deploy mode",
        mode,
        hint: mode === "docker"
          ? "Run: docker compose pull && docker compose up -d (or enable Watchtower for automatic updates)"
          : mode === "electron"
            ? "Updates are handled automatically by the desktop app. Check the system tray for update notifications, or restart the app to trigger a check."
            : "Git is not available in this environment",
      });
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      const send = (data: Record<string, unknown>) => s.write(`data: ${JSON.stringify(data)}\n\n`);

      const result = await applyProxySelfUpdate((step, status, detail) => {
        void send({ step, status, detail });
      });

      await send({ ...result, done: true });
    });
  });

  return app;
}
