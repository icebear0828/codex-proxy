/**
 * Proxy self-update — detects available updates in three deployment modes:
 * - CLI (git): git fetch + commit log
 * - Docker (no .git): GitHub Releases API
 * - Electron (embedded): GitHub Releases API
 */

import { execFile, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { promisify } from "util";
import { getRootDir, isEmbedded } from "./paths.js";

// ── Restart handler ──────────────────────────────────────────────────
let _onRestart: (() => void) | null = null;

/** Register a handler that will be called to restart the server process. */
export function setRestartHandler(handler: () => void): void {
  _onRestart = handler;
}

/** Schedule a server restart after a short delay (allows HTTP response to flush). */
export function scheduleRestart(): void {
  if (!_onRestart) {
    console.warn("[SelfUpdate] No restart handler registered, manual restart required.");
    return;
  }
  const handler = _onRestart;
  setTimeout(() => {
    console.log("[SelfUpdate] Restarting server...");
    handler();
  }, 500);
}

const execFileAsync = promisify(execFile);

const GITHUB_REPO = "icebear0828/codex-proxy";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 10_000; // 10 seconds after startup

export interface ProxyInfo {
  version: string;
  commit: string | null;
}

export interface CommitInfo {
  hash: string;
  message: string;
}

export interface GitHubReleaseInfo {
  version: string;
  tag: string;
  body: string;
  url: string;
  publishedAt: string;
}

export type DeployMode = "git" | "docker" | "electron";

export interface ProxySelfUpdateResult {
  commitsBehind: number;
  currentCommit: string | null;
  latestCommit: string | null;
  commits: CommitInfo[];
  release: GitHubReleaseInfo | null;
  updateAvailable: boolean;
  mode: DeployMode;
}

let _proxyUpdateInProgress = false;
let _gitAvailable: boolean | null = null;
let _cachedResult: ProxySelfUpdateResult | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _initialTimer: ReturnType<typeof setTimeout> | null = null;
let _checking = false;

/** Read proxy version from package.json + current git commit hash. */
export function getProxyInfo(): ProxyInfo {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(resolve(getRootDir(), "package.json"), "utf-8")) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch { /* ignore */ }

  let commit: string | null = null;
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
    });
    commit = out.trim() || null;
  } catch { /* ignore */ }

  return { version, commit };
}

/** Whether this environment supports git-based self-update. */
export function canSelfUpdate(): boolean {
  if (isEmbedded()) return false;
  if (_gitAvailable !== null) return _gitAvailable;

  if (!existsSync(resolve(process.cwd(), ".git"))) {
    _gitAvailable = false;
    return false;
  }

  try {
    execFileSync("git", ["--version"], {
      cwd: process.cwd(),
      timeout: 5000,
      stdio: "ignore",
    });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }

  return _gitAvailable;
}

/** Determine deployment mode. */
export function getDeployMode(): DeployMode {
  if (isEmbedded()) return "electron";
  if (canSelfUpdate()) return "git";
  return "docker";
}

/** Whether a proxy self-update is currently in progress. */
export function isProxyUpdateInProgress(): boolean {
  return _proxyUpdateInProgress;
}

/** Return cached proxy update result (set by periodic checker or manual check). */
export function getCachedProxyUpdateResult(): ProxySelfUpdateResult | null {
  return _cachedResult;
}

/** Get commit log between HEAD and origin/master. */
async function getCommitLog(cwd: string): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["log", "HEAD..origin/master", "--oneline", "--format=%h %s"],
      { cwd, timeout: 10000 },
    );
    return stdout.trim().split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const spaceIdx = line.indexOf(" ");
        return {
          hash: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
        };
      });
  } catch {
    return [];
  }
}

/** Check GitHub Releases API for the latest version. */
async function checkGitHubRelease(): Promise<GitHubReleaseInfo | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      tag_name?: string;
      body?: string | null;
      html_url?: string;
      published_at?: string;
    };
    return {
      version: String(data.tag_name ?? "").replace(/^v/, ""),
      tag: String(data.tag_name ?? ""),
      body: String(data.body ?? ""),
      url: String(data.html_url ?? ""),
      publishedAt: String(data.published_at ?? ""),
    };
  } catch {
    return null;
  }
}

/** Fetch latest from origin and check how many commits behind. */
export async function checkProxySelfUpdate(): Promise<ProxySelfUpdateResult> {
  const mode = getDeployMode();

  if (mode === "git") {
    const cwd = process.cwd();

    let currentCommit: string | null = null;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 });
      currentCommit = stdout.trim() || null;
    } catch { /* ignore */ }

    try {
      await execFileAsync("git", ["fetch", "origin", "master", "--quiet"], { cwd, timeout: 30000 });
    } catch (err) {
      console.warn("[SelfUpdate] git fetch failed:", err instanceof Error ? err.message : err);
      const result: ProxySelfUpdateResult = {
        commitsBehind: 0, currentCommit, latestCommit: currentCommit,
        commits: [], release: null, updateAvailable: false, mode,
      };
      _cachedResult = result;
      return result;
    }

    let commitsBehind = 0;
    let latestCommit: string | null = null;
    try {
      const { stdout: countOut } = await execFileAsync(
        "git", ["rev-list", "HEAD..origin/master", "--count"], { cwd, timeout: 5000 },
      );
      commitsBehind = parseInt(countOut.trim(), 10) || 0;

      const { stdout: latestOut } = await execFileAsync(
        "git", ["rev-parse", "--short", "origin/master"], { cwd, timeout: 5000 },
      );
      latestCommit = latestOut.trim() || null;
    } catch { /* ignore */ }

    const commits = commitsBehind > 0 ? await getCommitLog(cwd) : [];

    const result: ProxySelfUpdateResult = {
      commitsBehind, currentCommit, latestCommit,
      commits, release: null,
      updateAvailable: commitsBehind > 0, mode,
    };
    _cachedResult = result;
    return result;
  }

  // Docker or Electron — GitHub Releases API
  const release = await checkGitHubRelease();
  const currentVersion = getProxyInfo().version;
  const updateAvailable = release !== null
    && release.version !== currentVersion
    && release.version.localeCompare(currentVersion, undefined, { numeric: true }) > 0;

  const result: ProxySelfUpdateResult = {
    commitsBehind: 0, currentCommit: null, latestCommit: null,
    commits: [], release: updateAvailable ? release : null,
    updateAvailable, mode,
  };
  _cachedResult = result;
  return result;
}

/**
 * Apply proxy self-update: git pull + npm install + npm run build.
 * Only works in git (CLI) mode.
 */
export async function applyProxySelfUpdate(): Promise<{ started: boolean; restarting?: boolean; error?: string }> {
  if (_proxyUpdateInProgress) {
    return { started: false, error: "Update already in progress" };
  }

  _proxyUpdateInProgress = true;
  const cwd = process.cwd();

  try {
    console.log("[SelfUpdate] Pulling latest code...");
    await execFileAsync("git", ["pull", "origin", "master"], { cwd, timeout: 60000 });

    console.log("[SelfUpdate] Installing dependencies...");
    await execFileAsync("npm", ["install"], { cwd, timeout: 120000, shell: true });

    console.log("[SelfUpdate] Building...");
    await execFileAsync("npm", ["run", "build"], { cwd, timeout: 120000, shell: true });

    console.log("[SelfUpdate] Update complete. Scheduling restart...");
    _proxyUpdateInProgress = false;

    const willRestart = _onRestart !== null;
    if (willRestart) {
      scheduleRestart();
    }

    return { started: true, restarting: willRestart };
  } catch (err) {
    _proxyUpdateInProgress = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SelfUpdate] Update failed:", msg);
    return { started: false, error: msg };
  }
}

/** Run a background check (guards against concurrent execution). */
async function runCheck(): Promise<void> {
  if (_checking) return;
  _checking = true;
  try {
    await checkProxySelfUpdate();
  } catch (err) {
    console.warn("[SelfUpdate] Periodic check failed:", err instanceof Error ? err.message : err);
  } finally {
    _checking = false;
  }
}

/** Start periodic proxy update checking (initial check after 10s, then every 6h). */
export function startProxyUpdateChecker(): void {
  _initialTimer = setTimeout(() => {
    void runCheck();
  }, INITIAL_DELAY_MS);
  _initialTimer.unref();

  _checkTimer = setInterval(() => {
    void runCheck();
  }, CHECK_INTERVAL_MS);
  _checkTimer.unref();
}

/** Stop periodic proxy update checking. */
export function stopProxyUpdateChecker(): void {
  if (_initialTimer) {
    clearTimeout(_initialTimer);
    _initialTimer = null;
  }
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
}
