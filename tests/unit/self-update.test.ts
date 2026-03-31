/**
 * Tests for self-update — deploy mode detection, version info, update checking, and applying.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock variables (closure-based, safe across resetModules) ──────────

const _isEmbedded = vi.fn(() => false);
const _existsSync = vi.fn(() => true);
const _readFileSync = vi.fn(() => JSON.stringify({ version: "1.0.0" }));
const _execFileSync = vi.fn((): string => "");
const _execFileAsync = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

vi.mock("@src/paths.js", () => ({ isEmbedded: _isEmbedded, getRootDir: () => "/mock" }));
vi.mock("fs", () => ({ existsSync: _existsSync, readFileSync: _readFileSync, openSync: vi.fn(() => 99) }));
vi.mock("child_process", () => ({
  execFile: vi.fn(),
  execFileSync: _execFileSync,
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 12345 })),
}));
vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return { ...actual, promisify: vi.fn(() => _execFileAsync) };
});

// ── Import after mocks ───────────────────────────────────────────────

import type { ProxySelfUpdateResult } from "@src/self-update.js";

// Helper: dynamic import with fresh module state
async function importFresh() {
  return await import("@src/self-update.js");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("self-update", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Default: non-embedded, .git exists, git works, package.json readable
    _isEmbedded.mockReturnValue(false);
    _existsSync.mockReturnValue(true);
    _readFileSync.mockReturnValue(JSON.stringify({ version: "1.0.0" }));
    _execFileSync.mockReturnValue("");
    _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  });

  // ── getDeployMode ─────────────────────────────────────────────────

  describe("getDeployMode", () => {
    it("returns 'electron' when embedded", async () => {
      _isEmbedded.mockReturnValue(true);
      const { getDeployMode } = await importFresh();
      expect(getDeployMode()).toBe("electron");
    });

    it("returns 'git' when .git exists and git works", async () => {
      const { getDeployMode } = await importFresh();
      expect(getDeployMode()).toBe("git");
    });

    it("returns 'docker' when no .git directory", async () => {
      _existsSync.mockReturnValue(false);
      const { getDeployMode } = await importFresh();
      expect(getDeployMode()).toBe("docker");
    });
  });

  // ── getProxyInfo ──────────────────────────────────────────────────

  describe("getProxyInfo", () => {
    it("reads version from package.json", async () => {
      _readFileSync.mockReturnValue(JSON.stringify({ version: "1.2.3" }));
      const { getProxyInfo } = await importFresh();
      expect(getProxyInfo().version).toBe("1.2.3");
    });

    it("returns 'unknown' when package.json is unreadable", async () => {
      _readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
      // .git doesn't exist so canSelfUpdate returns false, no git calls
      _existsSync.mockReturnValue(false);
      const { getProxyInfo } = await importFresh();
      expect(getProxyInfo().version).toBeNull();
    });

    it("returns commit hash when git is available", async () => {
      _execFileSync.mockReturnValue("abc1234\n");
      const { getProxyInfo } = await importFresh();
      const info = getProxyInfo();
      expect(info.commit).toBe("abc1234");
    });

    it("returns null commit when not in git mode", async () => {
      _existsSync.mockReturnValue(false);
      const { getProxyInfo } = await importFresh();
      expect(getProxyInfo().commit).toBeNull();
    });
  });

  // ── canSelfUpdate ─────────────────────────────────────────────────

  describe("canSelfUpdate", () => {
    it("returns false when embedded", async () => {
      _isEmbedded.mockReturnValue(true);
      const { canSelfUpdate } = await importFresh();
      expect(canSelfUpdate()).toBe(false);
    });

    it("returns false when .git is missing", async () => {
      _existsSync.mockReturnValue(false);
      const { canSelfUpdate } = await importFresh();
      expect(canSelfUpdate()).toBe(false);
    });

    it("returns true when git works", async () => {
      const { canSelfUpdate } = await importFresh();
      expect(canSelfUpdate()).toBe(true);
    });

    it("returns false when git command fails", async () => {
      _execFileSync.mockImplementation((cmd: string, args?: string[]) => {
        if (args && args[0] === "--version") throw new Error("git not found");
        return "";
      });
      const { canSelfUpdate } = await importFresh();
      expect(canSelfUpdate()).toBe(false);
    });
  });

  // ── checkProxySelfUpdate (git mode) ───────────────────────────────

  describe("checkProxySelfUpdate (git mode)", () => {
    it("returns updateAvailable=false when up to date", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "abc1234\n", stderr: "" }) // rev-parse HEAD
        .mockResolvedValueOnce({ stdout: "", stderr: "" })          // git fetch
        .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })       // rev-list --count
        .mockResolvedValueOnce({ stdout: "abc1234\n", stderr: "" }); // rev-parse origin/master

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.commitsBehind).toBe(0);
      expect(result.commits).toEqual([]);
      expect(result.mode).toBe("git");
    });

    it("returns commits when behind", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa1111\n", stderr: "" }) // rev-parse HEAD
        .mockResolvedValueOnce({ stdout: "", stderr: "" })          // git fetch
        .mockResolvedValueOnce({ stdout: "3\n", stderr: "" })       // rev-list --count
        .mockResolvedValueOnce({ stdout: "bbb2222\n", stderr: "" }) // rev-parse origin/master
        .mockResolvedValueOnce({                                     // git log
          stdout: "ccc3333 fix: bug\nddd4444 feat: new\neee5555 chore: cleanup\n",
          stderr: "",
        });

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(true);
      expect(result.commitsBehind).toBe(3);
      expect(result.commits).toHaveLength(3);
      expect(result.currentCommit).toBe("aaa1111");
      expect(result.latestCommit).toBe("bbb2222");
    });

    it("populates commit log correctly", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "2\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bbb\n", stderr: "" })
        .mockResolvedValueOnce({
          stdout: "abc1234 fix: something broke\ndef5678 feat: add widget\n",
          stderr: "",
        });

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.commits[0]).toEqual({ hash: "abc1234", message: "fix: something broke" });
      expect(result.commits[1]).toEqual({ hash: "def5678", message: "feat: add widget" });
    });

    it("handles git fetch failure gracefully", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })    // rev-parse HEAD
        .mockRejectedValueOnce(new Error("network error"));        // git fetch fails

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.commitsBehind).toBe(0);
      expect(result.currentCommit).toBe("aaa");
    });
  });

  // ── checkProxySelfUpdate (docker mode) ────────────────────────────

  describe("checkProxySelfUpdate (docker mode)", () => {
    beforeEach(() => {
      // No .git → docker mode
      _existsSync.mockReturnValue(false);
    });

    it("returns release when update available", async () => {
      const releaseData = {
        tag_name: "v2.0.0",
        body: "New release notes",
        html_url: "https://github.com/repo/releases/v2.0.0",
        published_at: "2026-03-09T00:00:00Z",
      };

      // Mock package.json version (current) as 1.0.0
      _readFileSync.mockReturnValue(JSON.stringify({ version: "1.0.0" }));

      // Mock globalThis.fetch for GitHub API
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(releaseData),
      });
      vi.stubGlobal("fetch", mockFetch);

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(true);
      expect(result.release).not.toBeNull();
      expect(result.release!.version).toBe("2.0.0");
      expect(result.release!.body).toBe("New release notes");
      expect(result.mode).toBe("docker");

      vi.unstubAllGlobals();
    });

    it("returns no update when same version", async () => {
      _readFileSync.mockReturnValue(JSON.stringify({ version: "2.0.0" }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          tag_name: "v2.0.0",
          body: "",
          html_url: "",
          published_at: "",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.release).toBeNull();

      vi.unstubAllGlobals();
    });

    it("suppresses false update when Docker image was built after release", async () => {
      // Package.json says 1.0.0, release says 2.0.0 — normally an update
      _readFileSync.mockImplementation((path: string) => {
        if (String(path).includes(".docker-build-time")) {
          return "2026-03-10T12:00:00Z\n"; // built AFTER release
        }
        return JSON.stringify({ version: "1.0.0" });
      });
      _existsSync.mockReturnValue(false); // no .git → docker mode

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          tag_name: "v2.0.0",
          body: "Notes",
          html_url: "https://github.com/repo/releases/v2.0.0",
          published_at: "2026-03-09T00:00:00Z", // released BEFORE build
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      // Build time > release time → suppress false positive
      expect(result.updateAvailable).toBe(false);
      expect(result.release).toBeNull();

      vi.unstubAllGlobals();
    });

    it("shows update when Docker image was built before release", async () => {
      _readFileSync.mockImplementation((path: string) => {
        if (String(path).includes(".docker-build-time")) {
          return "2026-03-08T00:00:00Z\n"; // built BEFORE release
        }
        return JSON.stringify({ version: "1.0.0" });
      });
      _existsSync.mockReturnValue(false);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          tag_name: "v2.0.0",
          body: "Notes",
          html_url: "https://github.com/repo/releases/v2.0.0",
          published_at: "2026-03-09T00:00:00Z",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(true);
      expect(result.release).not.toBeNull();

      vi.unstubAllGlobals();
    });

    it("handles GitHub API error gracefully", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("network failure"));
      vi.stubGlobal("fetch", mockFetch);

      const { checkProxySelfUpdate } = await importFresh();
      const result = await checkProxySelfUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.release).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  // ── getCachedProxyUpdateResult ────────────────────────────────────

  describe("getCachedProxyUpdateResult", () => {
    it("returns null before first check", async () => {
      const { getCachedProxyUpdateResult } = await importFresh();
      expect(getCachedProxyUpdateResult()).toBeNull();
    });

    it("returns result after check", async () => {
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "aaa\n", stderr: "" });

      const { checkProxySelfUpdate, getCachedProxyUpdateResult } = await importFresh();
      await checkProxySelfUpdate();
      const cached = getCachedProxyUpdateResult();
      expect(cached).not.toBeNull();
      expect(cached!.mode).toBe("git");
    });
  });

  // ── applyProxySelfUpdate ──────────────────────────────────────────

  describe("applyProxySelfUpdate", () => {
    it("runs git checkout + git pull + npm install + npm run build", async () => {
      _execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const { applyProxySelfUpdate } = await importFresh();
      const result = await applyProxySelfUpdate();
      expect(result.started).toBe(true);
      expect(result.error).toBeUndefined();

      // 4 sequential calls: git checkout -- ., git pull, npm install, npm run build
      expect(_execFileAsync).toHaveBeenCalledTimes(4);
    });

    it("returns error when step fails", async () => {
      // First call is "git checkout -- ." which has .catch(() => {}), so it swallows errors.
      // Reject the second call (git pull) to trigger the error path.
      _execFileAsync
        .mockResolvedValueOnce({ stdout: "", stderr: "" })   // git checkout -- .
        .mockRejectedValueOnce(new Error("git pull failed")); // git pull

      const { applyProxySelfUpdate } = await importFresh();
      const result = await applyProxySelfUpdate();
      expect(result.started).toBe(false);
      expect(result.error).toContain("git pull failed");
    });

    it("returns error when already in progress", async () => {
      // Make first call hang
      let resolveFirst: (() => void) | undefined;
      _execFileAsync.mockImplementationOnce(
        () => new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveFirst = () => resolve({ stdout: "", stderr: "" });
        }),
      );

      const { applyProxySelfUpdate } = await importFresh();

      // Start first update (will hang on git pull)
      const first = applyProxySelfUpdate();

      // Second call while first is in progress
      const second = await applyProxySelfUpdate();
      expect(second.started).toBe(false);
      expect(second.error).toContain("already in progress");

      // Cleanup: resolve the hanging promise
      resolveFirst?.();
      await first;
    });
  });
});
