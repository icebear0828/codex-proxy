/**
 * Integration tests for web update routes (/admin/update-status, /admin/check-update, /admin/apply-update).
 *
 * Uses a real Hono app with mocked self-update and update-checker modules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { DeployMode, ProxySelfUpdateResult } from "@src/self-update.js";
import type { UpdateState } from "@src/update-checker.js";

// ── Module-level mock control variables ──────────────────────────────

let _deployMode: DeployMode = "git";
let _canSelfUpdate = true;
let _cachedResult: ProxySelfUpdateResult | null = null;
let _checkResult: ProxySelfUpdateResult = {
  commitsBehind: 0,
  currentCommit: "abc1234",
  latestCommit: "abc1234",
  commits: [],
  release: null,
  updateAvailable: false,
  mode: "git",
};
let _applyResult: { started: boolean; error?: string } = { started: true };
let _updateState: UpdateState | null = null;
let _proxyUpdateInProgress = false;
let _codexUpdateInProgress = false;
let _checkForUpdateResult: UpdateState = {
  last_check: "2026-03-09T00:00:00Z",
  latest_version: "1.0.0",
  latest_build: "100",
  download_url: null,
  update_available: false,
  current_version: "1.0.0",
  current_build: "100",
};

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("@src/self-update.js", () => ({
  getProxyInfo: vi.fn(() => ({ version: "1.0.0", commit: "abc1234" })),
  canSelfUpdate: vi.fn(() => _canSelfUpdate),
  getDeployMode: vi.fn(() => _deployMode),
  getCachedProxyUpdateResult: vi.fn(() => _cachedResult),
  checkProxySelfUpdate: vi.fn(async () => _checkResult),
  applyProxySelfUpdate: vi.fn(async () => _applyResult),
  isProxyUpdateInProgress: vi.fn(() => _proxyUpdateInProgress),
}));

vi.mock("@src/update-checker.js", () => ({
  getUpdateState: vi.fn(() => _updateState),
  checkForUpdate: vi.fn(async () => _checkForUpdateResult),
  isUpdateInProgress: vi.fn(() => _codexUpdateInProgress),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    client: { app_version: "1.0.0", build_number: "100", platform: "darwin", arch: "arm64", originator: "test" },
    api: { base_url: "https://chatgpt.com" },
    model: { default: "codex" },
  })),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version} ({platform}; {arch})",
    header_order: [],
  })),
}));

vi.mock("@src/paths.js", () => ({
  getPublicDir: vi.fn(() => "/tmp/public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/public-desktop"),
  getConfigDir: vi.fn(() => "/tmp/config"),
  getDataDir: vi.fn(() => "/tmp/data"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "<html>mock</html>"),
  existsSync: vi.fn(() => false),
}));

// ── Import after mocks ───────────────────────────────────────────────

import { createWebRoutes } from "@src/routes/web.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockAccountPool() {
  return {
    isAuthenticated: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({ total: 2, active: 2, rate_limited: 0, expired: 0 })),
  };
}

function buildApp() {
  const accountPool = createMockAccountPool();
  const webRoutes = createWebRoutes(accountPool as never);
  const app = new Hono();
  app.route("/", webRoutes);
  return { app, accountPool };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("web update routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset control variables
    _deployMode = "git";
    _canSelfUpdate = true;
    _cachedResult = null;
    _checkResult = {
      commitsBehind: 0,
      currentCommit: "abc1234",
      latestCommit: "abc1234",
      commits: [],
      release: null,
      updateAvailable: false,
      mode: "git",
    };
    _applyResult = { started: true };
    _updateState = null;
    _proxyUpdateInProgress = false;
    _codexUpdateInProgress = false;
  });

  // ── GET /admin/update-status ────────────────────────────────────

  describe("GET /admin/update-status", () => {
    it("returns mode and empty data when no cache", async () => {
      const { app } = buildApp();
      const res = await app.request("/admin/update-status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.proxy.mode).toBe("git");
      expect(body.proxy.commits).toEqual([]);
      expect(body.proxy.update_available).toBe(false);
      expect(body.proxy.version).toBe("1.0.0");
      expect(body.proxy.commit).toBe("abc1234");
    });

    it("returns cached commits for git mode", async () => {
      _cachedResult = {
        commitsBehind: 2,
        currentCommit: "aaa",
        latestCommit: "bbb",
        commits: [
          { hash: "ccc", message: "fix: bug" },
          { hash: "ddd", message: "feat: new" },
        ],
        release: null,
        updateAvailable: true,
        mode: "git",
      };

      const { app } = buildApp();
      const res = await app.request("/admin/update-status");
      const body = await res.json();

      expect(body.proxy.commits_behind).toBe(2);
      expect(body.proxy.commits).toHaveLength(2);
      expect(body.proxy.update_available).toBe(true);
      expect(body.proxy.release).toBeNull();
    });

    it("returns cached release for docker mode", async () => {
      _deployMode = "docker";
      _cachedResult = {
        commitsBehind: 0,
        currentCommit: null,
        latestCommit: null,
        commits: [],
        release: {
          version: "2.0.0",
          tag: "v2.0.0",
          body: "Release notes here",
          url: "https://github.com/repo/releases/v2.0.0",
          publishedAt: "2026-03-09T00:00:00Z",
        },
        updateAvailable: true,
        mode: "docker",
      };

      const { app } = buildApp();
      const res = await app.request("/admin/update-status");
      const body = await res.json();

      expect(body.proxy.mode).toBe("docker");
      expect(body.proxy.release).not.toBeNull();
      expect(body.proxy.release.version).toBe("2.0.0");
      expect(body.proxy.release.body).toBe("Release notes here");
      expect(body.proxy.release.url).toBe("https://github.com/repo/releases/v2.0.0");
    });

    it("returns electron mode with release info", async () => {
      _deployMode = "electron";
      _canSelfUpdate = false;
      _cachedResult = {
        commitsBehind: 0,
        currentCommit: null,
        latestCommit: null,
        commits: [],
        release: {
          version: "2.0.0",
          tag: "v2.0.0",
          body: "New version",
          url: "https://github.com/repo/releases/v2.0.0",
          publishedAt: "2026-03-17T00:00:00Z",
        },
        updateAvailable: true,
        mode: "electron",
      };

      const { app } = buildApp();
      const res = await app.request("/admin/update-status");
      const body = await res.json();

      expect(body.proxy.mode).toBe("electron");
      expect(body.proxy.can_self_update).toBe(false);
      expect(body.proxy.update_available).toBe(true);
      expect(body.proxy.release.version).toBe("2.0.0");
    });
  });

  // ── POST /admin/check-update ────────────────────────────────────

  describe("POST /admin/check-update", () => {
    it("returns commits for git mode", async () => {
      _checkResult = {
        commitsBehind: 1,
        currentCommit: "aaa",
        latestCommit: "bbb",
        commits: [{ hash: "bbb", message: "fix: important" }],
        release: null,
        updateAvailable: true,
        mode: "git",
      };

      const { app } = buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.proxy.commits_behind).toBe(1);
      expect(body.proxy.commits).toHaveLength(1);
      expect(body.proxy.update_available).toBe(true);
      expect(body.proxy.mode).toBe("git");
    });

    it("returns release for docker mode", async () => {
      _deployMode = "docker";
      _checkResult = {
        commitsBehind: 0,
        currentCommit: null,
        latestCommit: null,
        commits: [],
        release: {
          version: "2.0.0",
          tag: "v2.0.0",
          body: "What's new",
          url: "https://github.com/repo/releases/v2.0.0",
          publishedAt: "2026-03-09T00:00:00Z",
        },
        updateAvailable: true,
        mode: "docker",
      };

      const { app } = buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      const body = await res.json();

      expect(body.proxy.release).not.toBeNull();
      expect(body.proxy.release.version).toBe("2.0.0");
      expect(body.proxy.update_available).toBe(true);
    });

    it("handles check error gracefully", async () => {
      const { checkProxySelfUpdate } = await import("@src/self-update.js");
      vi.mocked(checkProxySelfUpdate).mockRejectedValueOnce(new Error("git timeout"));

      const { app } = buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.proxy.error).toBe("git timeout");
      expect(body.proxy.update_available).toBe(false);
    });
  });

  // ── POST /admin/apply-update ────────────────────────────────────

  describe("POST /admin/apply-update", () => {
    it("applies update when canSelfUpdate (SSE stream)", async () => {
      _applyResult = { started: true };

      const { app } = buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Parse SSE stream to find the final "done" message
      const text = await res.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const lastData = JSON.parse(lines[lines.length - 1].slice(6));
      expect(lastData.done).toBe(true);
      expect(lastData.started).toBe(true);
    });

    it("rejects docker mode with Watchtower hint", async () => {
      _canSelfUpdate = false;
      _deployMode = "docker";

      const { app } = buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.started).toBe(false);
      expect(body.error).toContain("not available");
      expect(body.mode).toBe("docker");
      expect(body.hint).toContain("docker compose pull");
      expect(body.hint).toContain("Watchtower");
    });

    it("rejects electron mode with auto-updater hint", async () => {
      _canSelfUpdate = false;
      _deployMode = "electron";

      const { app } = buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.started).toBe(false);
      expect(body.mode).toBe("electron");
      expect(body.hint).toContain("automatically");
      expect(body.hint).toContain("system tray");
    });

    it("returns error from apply (SSE stream)", async () => {
      _applyResult = { started: false, error: "npm install failed" };

      const { app } = buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });
      expect(res.status).toBe(200);

      // Parse SSE stream to find the final "done" message with error
      const text = await res.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const lastData = JSON.parse(lines[lines.length - 1].slice(6));
      expect(lastData.done).toBe(true);
      expect(lastData.started).toBe(false);
      expect(lastData.error).toBe("npm install failed");
    });
  });
});
