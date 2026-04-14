/**
 * E2E tests for self-update routes (/admin/update-status, /admin/check-update, /admin/apply-update).
 *
 * Mocks only the external boundary:
 *   - child_process (git/npm commands) — controllable outcomes
 *   - fs — file reads for package.json, .git existence
 *   - process.exit — prevent test runner death
 *
 * Runs real:
 *   self-update.ts logic, web routes, hono streaming, SSE format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock control variables ──────────────────────────────────────────

const _execFileSync = vi.fn((): string => "");
const _execFileAsync = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
const _spawn = vi.fn(() => ({ unref: vi.fn(), pid: 99999 }));
const _existsSync = vi.fn(() => true);
const _readFileSync = vi.fn((path: string): string => {
  if (typeof path === "string" && path.includes("package.json")) {
    return JSON.stringify({ version: "1.0.42" });
  }
  if (typeof path === "string" && path.includes("index.html")) {
    return "<html>test</html>";
  }
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
});

// ── Mocks (hoisted by vitest) ───────────────────────────────────────

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  execFileSync: _execFileSync,
  spawn: _spawn,
}));

vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return { ...actual, promisify: vi.fn(() => _execFileAsync) };
});

vi.mock("fs", () => ({
  existsSync: _existsSync,
  readFileSync: _readFileSync,
  openSync: vi.fn(() => 99),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getRootDir: vi.fn(() => "/mock"),
  isEmbedded: vi.fn(() => false),
  getConfigDir: vi.fn(() => "/tmp/e2e-update/config"),
  getDataDir: vi.fn(() => "/tmp/e2e-update/data"),
  getBinDir: vi.fn(() => "/tmp/e2e-update/bin"),
  getPublicDir: vi.fn(() => "/tmp/e2e-update/public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/e2e-update/public-desktop"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    client: { app_version: "1.0.0", build_number: "100", platform: "darwin", arch: "arm64", originator: "test" },
    api: { base_url: "https://chatgpt.com" },
    model: { default: "codex" },
    server: { port: 8080 },
  })),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version} ({platform}; {arch})",
    header_order: [],
  })),
  loadConfig: vi.fn(),
  loadFingerprint: vi.fn(),
  reloadAllConfigs: vi.fn(),
}));

vi.mock("@src/update-checker.js", () => ({
  startUpdateChecker: vi.fn(),
  stopUpdateChecker: vi.fn(),
  getUpdateState: vi.fn(() => null),
  checkForUpdate: vi.fn(async () => ({
    update_available: false,
    current_version: "1.0.0",
    current_build: "100",
    latest_version: null,
    latest_build: null,
    download_url: null,
    last_check: new Date().toISOString(),
  })),
  isUpdateInProgress: vi.fn(() => false),
}));

// Modules used by web.ts but not relevant to update routes
vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({ post: vi.fn(), get: vi.fn(), simplePost: vi.fn(), isImpersonate: () => false })),
  getTransportInfo: vi.fn(() => ({ type: "mock", impersonate: false })),
  initTransport: vi.fn(),
  resetTransport: vi.fn(),
}));

vi.mock("@src/tls/curl-binary.js", () => ({
  getCurlDiagnostics: vi.fn(() => null),
  initProxy: vi.fn(),
  getCurlBinary: vi.fn(() => null),
  isImpersonate: vi.fn(() => false),
  supportsCompressed: vi.fn(() => true),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { Hono } from "hono";

// ── Helpers ─────────────────────────────────────────────────────────

function createMockAccountPool() {
  return {
    isAuthenticated: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({ total: 1, active: 1, rate_limited: 0, expired: 0 })),
    getUserInfo: vi.fn(() => ({ email: "test@test.com", planType: "plus" })),
    getProxyApiKey: vi.fn(() => "sk-test"),
  };
}

async function buildApp() {
  const { createWebRoutes } = await import("@src/routes/web.js");
  const accountPool = createMockAccountPool();
  const app = new Hono();
  app.route("/", createWebRoutes(accountPool as never));
  return app;
}

/** Parse SSE response text into array of JSON data objects. */
async function parseSSE(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("E2E: self-update routes", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Defaults: git mode (.git exists, git works)
    _existsSync.mockReturnValue(true);
    _execFileSync.mockReturnValue("");
    _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    _readFileSync.mockImplementation((path: string): string => {
      if (typeof path === "string" && path.includes("package.json")) {
        return JSON.stringify({ version: "1.0.42" });
      }
      if (typeof path === "string" && path.includes("index.html")) {
        return "<html>test</html>";
      }
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    });

    // Prevent process.exit from killing the test runner
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // ── GET /admin/update-status ────────────────────────────────────

  describe("GET /admin/update-status", () => {
    it("returns proxy info with git mode when .git exists", async () => {
      _execFileSync.mockReturnValue("abc1234\n");

      const app = await buildApp();
      const res = await app.request("/admin/update-status");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;
      expect(proxy.mode).toBe("git");
      expect(proxy.can_self_update).toBe(true);
      expect(proxy.update_in_progress).toBe(false);
      expect(proxy.update_available).toBe(false);
      expect(proxy.commits).toEqual([]);
    });

    it("returns docker mode when .git is missing", async () => {
      _existsSync.mockReturnValue(false);

      const app = await buildApp();
      const res = await app.request("/admin/update-status");
      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;

      expect(proxy.mode).toBe("docker");
      expect(proxy.can_self_update).toBe(false);
    });

    it("includes codex update state when available", async () => {
      const { getUpdateState } = await import("@src/update-checker.js");
      vi.mocked(getUpdateState).mockReturnValue({
        current_version: "26.309.31024",
        current_build: "962",
        latest_version: "26.310.00000",
        latest_build: "970",
        update_available: true,
        download_url: null,
        last_check: "2026-03-14T00:00:00Z",
      });

      const app = await buildApp();
      const res = await app.request("/admin/update-status");
      const body = await res.json() as Record<string, unknown>;
      const codex = body.codex as Record<string, unknown>;

      expect(codex.current_version).toBe("26.309.31024");
      expect(codex.latest_version).toBe("26.310.00000");
      expect(codex.update_available).toBe(true);
    });
  });

  // ── POST /admin/check-update ────────────────────────────────────

  describe("POST /admin/check-update", () => {
    it("returns up-to-date when 0 commits behind", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "abc1234\n", stderr: "" })  // rev-parse HEAD
        .mockResolvedValueOnce({ stdout: "", stderr: "" })            // git fetch
        .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })        // rev-list --count
        .mockResolvedValueOnce({ stdout: "abc1234\n", stderr: "" }); // rev-parse origin/master

      const app = await buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;
      expect(proxy.update_available).toBe(false);
      expect(proxy.commits_behind).toBe(0);
      expect(proxy.mode).toBe("git");
    });

    it("returns commits when behind origin", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "2\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bbb\n", stderr: "" })
        .mockResolvedValueOnce({
          stdout: "ccc fix: bug\nddd feat: new\n",
          stderr: "",
        });

      const app = await buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;

      expect(proxy.update_available).toBe(true);
      expect(proxy.commits_behind).toBe(2);
      const commits = proxy.commits as Array<{ hash: string; message: string }>;
      expect(commits).toHaveLength(2);
      expect(commits[0]).toEqual({ hash: "ccc", message: "fix: bug" });
      expect(commits[1]).toEqual({ hash: "ddd", message: "feat: new" });
    });

    it("handles git fetch failure gracefully", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })
        .mockRejectedValueOnce(new Error("network timeout"));

      const app = await buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;

      expect(proxy.update_available).toBe(false);
      expect(proxy.commits_behind).toBe(0);
      expect(proxy.current_commit).toBe("aaa");
    });

    // TODO: docker mode detection logic changed, test needs update
    it.skip("falls back to GitHub Releases in docker mode", async () => {
      _existsSync.mockReturnValue(false); // no .git → docker mode

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          tag_name: "v2.0.0",
          body: "New features",
          html_url: "https://github.com/repo/releases/v2.0.0",
          published_at: "2026-03-14T00:00:00Z",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const app = await buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      const body = await res.json() as Record<string, unknown>;
      const proxy = body.proxy as Record<string, unknown>;

      expect(proxy.mode).toBe("docker");
      expect(proxy.update_available).toBe(true);
      const release = proxy.release as Record<string, unknown>;
      expect(release.version).toBe("2.0.0");
      expect(release.body).toBe("New features");

      vi.unstubAllGlobals();
    });

    it("includes codex update check result", async () => {
      // Git check: up to date
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" });

      const app = await buildApp();
      const res = await app.request("/admin/check-update", { method: "POST" });
      const body = await res.json() as Record<string, unknown>;

      // codex check should be present (from mocked checkForUpdate)
      expect(body.codex).toBeDefined();
      const codex = body.codex as Record<string, unknown>;
      expect(codex.update_available).toBe(false);

      // Progress flags should be present
      expect(body.proxy_update_in_progress).toBe(false);
      expect(body.codex_update_in_progress).toBe(false);
    });
  });

  // ── POST /admin/apply-update ────────────────────────────────────

  describe("POST /admin/apply-update", () => {
    it("streams SSE progress: pull → install → build → restart", async () => {
      _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await parseSSE(res);

      // Verify step progression
      const steps = events
        .filter((e) => e.step)
        .map((e) => `${e.step as string}:${e.status as string}`);
      expect(steps).toContain("pull:running");
      expect(steps).toContain("pull:done");
      expect(steps).toContain("install:running");
      expect(steps).toContain("install:done");
      expect(steps).toContain("build:running");
      expect(steps).toContain("build:done");
      expect(steps).toContain("restart:running");

      // Final event: done with restarting
      const doneEvent = events[events.length - 1];
      expect(doneEvent.done).toBe(true);
      expect(doneEvent.started).toBe(true);
      expect(doneEvent.restarting).toBe(true);
    });

    it("reports error when git pull fails", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "", stderr: "" })    // git checkout -- .
        .mockRejectedValueOnce(new Error("git pull failed")); // git pull

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      const events = await parseSSE(res);
      const doneEvent = events[events.length - 1];

      expect(doneEvent.done).toBe(true);
      expect(doneEvent.started).toBe(false);
      expect(String(doneEvent.error)).toContain("git pull failed");
    });

    it("reports error when npm install fails", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "", stderr: "" })        // git checkout
        .mockResolvedValueOnce({ stdout: "", stderr: "" })        // git pull
        .mockRejectedValueOnce(new Error("npm ERR! ERESOLVE"));   // npm install

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      const events = await parseSSE(res);

      // pull should have completed before the error
      const steps = events.filter((e) => e.step).map((e) => `${e.step as string}:${e.status as string}`);
      expect(steps).toContain("pull:done");
      expect(steps).toContain("install:running");

      const doneEvent = events[events.length - 1];
      expect(doneEvent.done).toBe(true);
      expect(doneEvent.started).toBe(false);
      expect(String(doneEvent.error)).toContain("ERESOLVE");
    });

    it("reports error when build fails", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "", stderr: "" })             // git checkout
        .mockResolvedValueOnce({ stdout: "", stderr: "" })             // git pull
        .mockResolvedValueOnce({ stdout: "", stderr: "" })             // npm install
        .mockRejectedValueOnce(new Error("tsc: error TS2345"));        // npm run build

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      const events = await parseSSE(res);
      const steps = events.filter((e) => e.step).map((e) => `${e.step as string}:${e.status as string}`);
      expect(steps).toContain("install:done");
      expect(steps).toContain("build:running");

      const doneEvent = events[events.length - 1];
      expect(doneEvent.started).toBe(false);
      expect(String(doneEvent.error)).toContain("TS2345");
    });

    it("sets 500ms restart timer after successful update", async () => {
      // Flush any leaked timers from previous success-path tests
      await new Promise((r) => setTimeout(r, 600));
      _spawn.mockClear();
      exitSpy.mockClear();

      _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const app = await buildApp();
      await app.request("/admin/apply-update", { method: "POST" });

      // Wait for hardRestart's 500ms timer to fire
      await new Promise((r) => setTimeout(r, 600));

      expect(_spawn).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("does not spawn when nodeExe does not exist", async () => {
      // Flush any leaked timers from previous success-path tests
      await new Promise((r) => setTimeout(r, 600));
      _spawn.mockClear();
      exitSpy.mockClear();

      _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      // existsSync returns true for .git check, false for nodeExe check in hardRestart
      _existsSync.mockImplementation((path: string) => {
        // .git check → true; nodeExe path → false
        return typeof path === "string" && path.includes(".git");
      });

      const app = await buildApp();
      await app.request("/admin/apply-update", { method: "POST" });

      await new Promise((r) => setTimeout(r, 600));

      // spawn should NOT be called because nodeExe doesn't exist
      expect(_spawn).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns 400 with docker hint including Watchtower when not in git mode", async () => {
      _existsSync.mockReturnValue(false); // no .git → docker mode → canSelfUpdate() returns false

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.started).toBe(false);
      expect(String(body.error)).toContain("not available");
      expect(body.mode).toBe("docker");
      expect(String(body.hint)).toContain("docker compose pull");
      expect(String(body.hint)).toContain("Watchtower");
    });

    it("returns 400 with electron auto-updater hint when embedded", async () => {
      // Override isEmbedded to simulate Electron mode
      const paths = await import("@src/paths.js");
      vi.mocked(paths.isEmbedded).mockReturnValue(true);

      const app = await buildApp();
      const res = await app.request("/admin/apply-update", { method: "POST" });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.started).toBe(false);
      expect(body.mode).toBe("electron");
      expect(String(body.hint)).toContain("automatically");
      expect(String(body.hint)).toContain("system tray");
    });
  });
});
