/**
 * Update checker — polls the Codex Sparkle appcast for new versions.
 * Automatically applies version updates to config file and runtime.
 * Fingerprint extraction is optional because the public repo does not ship the
 * private Codex Desktop downloader; set CODEX_DESKTOP_PATH/CODEX_APP_PATH to
 * run extraction against a local app bundle or extracted ASAR.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { fork } from "child_process";
import yaml from "js-yaml";
import { mutateClientConfig, reloadAllConfigs } from "./config.js";
import { jitterInt } from "./utils/jitter.js";
import { mutateYaml } from "./utils/yaml-mutate.js";
import { curlFetchGet } from "./tls/curl-fetch.js";
import { getConfigDir, getDataDir, isEmbedded } from "./paths.js";

function getConfigPath(): string {
  return resolve(getConfigDir(), "default.yaml");
}
function getStatePath(): string {
  return resolve(getDataDir(), "update-state.json");
}
const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const POLL_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface UpdateState {
  last_check: string;
  latest_version: string | null;
  latest_build: string | null;
  download_url: string | null;
  update_available: boolean;
  current_version: string;
  current_build: string;
}

let _currentState: UpdateState | null = null;
let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _updateInProgress = false;

function getVersionOverridePath(): string {
  return resolve(getDataDir(), "version-state.json");
}

function getExtractedFingerprintPath(): string {
  return resolve(getDataDir(), "extracted-fingerprint.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function loadCurrentConfig(): { app_version: string; build_number: string } {
  // Check runtime override first (written by applyVersionUpdate)
  try {
    const overridePath = getVersionOverridePath();
    if (existsSync(overridePath)) {
      const override = JSON.parse(readFileSync(overridePath, "utf-8")) as {
        app_version: string;
        build_number: string;
      };
      if (override.app_version && override.build_number) {
        return override;
      }
    }
  } catch {
    // Corrupt override — fall through to YAML baseline
  }

  const raw = yaml.load(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
  const client = raw.client as Record<string, string>;
  return {
    app_version: client.app_version,
    build_number: client.build_number,
  };
}

function readMatchingExtractedChromiumVersion(version: string, build: string): string | undefined {
  try {
    const extractedPath = getExtractedFingerprintPath();
    if (!existsSync(extractedPath)) return undefined;

    const parsed = JSON.parse(readFileSync(extractedPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) return undefined;

    if (optionalString(parsed.app_version) !== version) return undefined;
    if (optionalString(parsed.build_number) !== build) return undefined;

    return optionalString(parsed.chromium_version);
  } catch {
    return undefined;
  }
}

function syncDefaultConfigVersion(version: string, build: string, chromiumVersion?: string): void {
  mutateYaml(getConfigPath(), (data) => {
    const existingClient = data.client;
    const client: Record<string, unknown> = isRecord(existingClient) ? existingClient : {};
    data.client = client;
    client.app_version = version;
    client.build_number = build;
    if (chromiumVersion) {
      client.chromium_version = chromiumVersion;
    }
  });
}

function parseAppcast(xml: string): {
  version: string | null;
  build: string | null;
  downloadUrl: string | null;
} {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) return { version: null, build: null, downloadUrl: null };
  const item = itemMatch[1];
  // Support both attribute syntax (sparkle:version="X") and element syntax (<sparkle:version>X</sparkle:version>)
  const versionMatch =
    item.match(/sparkle:shortVersionString="([^"]+)"/) ??
    item.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/);
  const buildMatch =
    item.match(/sparkle:version="([^"]+)"/) ??
    item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);
  const urlMatch = item.match(/url="([^"]+)"/);
  return {
    version: versionMatch?.[1] ?? null,
    build: buildMatch?.[1] ?? null,
    downloadUrl: urlMatch?.[1] ?? null,
  };
}

function applyVersionUpdate(version: string, build: string): void {
  const chromiumVersion = readMatchingExtractedChromiumVersion(version, build);
  const versionState = {
    app_version: version,
    build_number: build,
    ...(chromiumVersion ? { chromium_version: chromiumVersion } : {}),
  };

  // Persist runtime override for cold starts before config reload.
  try {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      getVersionOverridePath(),
      JSON.stringify(versionState, null, 2),
    );
  } catch {
    // best-effort persistence
  }

  // Keep the YAML baseline current so the configured fingerprint does not drift
  // back to stale Desktop UA/build values after cleanup or deployment.
  try {
    syncDefaultConfigVersion(version, build, chromiumVersion);
  } catch {
    // best-effort persistence; runtime override above still keeps this process current
  }

  mutateClientConfig(versionState);
}

/**
 * Trigger the full-update pipeline in a background child process.
 * Downloads new Codex.app, extracts fingerprint, and applies config updates.
 * Protected by a lock to prevent concurrent runs.
 */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getConfiguredCodexSourcePath(): string | null {
  const value = process.env.CODEX_DESKTOP_PATH ?? process.env.CODEX_APP_PATH ?? null;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function triggerFullUpdate(codexSourcePath: string | null = getConfiguredCodexSourcePath()): void {
  if (_updateInProgress) {
    console.log("[UpdateChecker] Full update already in progress, skipping");
    return;
  }

  // Skip fork-based update in embedded (Electron) mode — no tsx/scripts available
  if (isEmbedded()) {
    console.log("[UpdateChecker] Embedded mode — skipping full-update pipeline");
    return;
  }

  if (!codexSourcePath) {
    console.log(
      "[UpdateChecker] Skipping full-update pipeline: set CODEX_DESKTOP_PATH or CODEX_APP_PATH to a local Codex.app/extracted ASAR path",
    );
    return;
  }

  _updateInProgress = true;
  console.log("[UpdateChecker] Triggering full-update pipeline...");

  const child = fork(
    resolve(process.cwd(), "scripts/build/full-update.ts"),
    ["--path", codexSourcePath],
    {
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      cwd: process.cwd(),
    },
  );

  // Kill the child if it hangs beyond the timeout
  const killTimer = setTimeout(() => {
    console.warn("[UpdateChecker] Full update timed out, killing child");
    child.kill("SIGTERM");
  }, UPDATE_TIMEOUT_MS);

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  child.on("exit", (code) => {
    clearTimeout(killTimer);
    _updateInProgress = false;
    if (code === 0) {
      console.log("[UpdateChecker] Full update completed. Reloading config...");
      try {
        reloadAllConfigs();
      } catch (err) {
        console.error("[UpdateChecker] Failed to reload config after update:", err instanceof Error ? err.message : err);
      }
    } else {
      console.warn(`[UpdateChecker] Full update exited with code ${code}`);
      if (output) {
        // Log last few lines for debugging
        const lines = output.trim().split("\n").slice(-5);
        for (const line of lines) {
          console.warn(`[UpdateChecker]   ${line}`);
        }
      }
    }
  });

  child.on("error", (err) => {
    clearTimeout(killTimer);
    _updateInProgress = false;
    console.error("[UpdateChecker] Failed to spawn full-update:", err.message);
  });
}

export async function checkForUpdate(): Promise<UpdateState> {
  const current = loadCurrentConfig();
  const res = await curlFetchGet(APPCAST_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch appcast: ${res.status}`);
  }
  const xml = res.body;
  const { version, build, downloadUrl } = parseAppcast(xml);

  const updateAvailable = !!(version && build &&
    (version !== current.app_version || build !== current.build_number));

  const state: UpdateState = {
    last_check: new Date().toISOString(),
    latest_version: version,
    latest_build: build,
    download_url: downloadUrl,
    update_available: updateAvailable,
    current_version: current.app_version,
    current_build: current.build_number,
  };

  _currentState = state;

  // Persist state
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // best-effort persistence
  }

  if (updateAvailable) {
    console.log(
      `[UpdateChecker] *** UPDATE AVAILABLE: v${version} (build ${build}) — current: v${current.app_version} (build ${current.build_number})`,
    );
    applyVersionUpdate(version!, build!);
    state.current_version = version!;
    state.current_build = build!;
    state.update_available = false;
    console.log(`[UpdateChecker] Auto-applied: v${version} (build ${build})`);

    // Trigger full-update pipeline in background (download + fingerprint extraction)
    triggerFullUpdate();
  }

  return state;
}

/** Get the most recent update check state. */
export function getUpdateState(): UpdateState | null {
  return _currentState;
}

/** Whether a full-update pipeline is currently running. */
export function isUpdateInProgress(): boolean {
  return _updateInProgress;
}

function scheduleNextPoll(): void {
  _pollTimer = setTimeout(() => {
    checkForUpdate().catch((err) => {
      console.warn(`[UpdateChecker] Poll failed: ${err instanceof Error ? err.message : err}`);
    });
    scheduleNextPoll();
  }, jitterInt(POLL_INTERVAL_MS, 0.1));
  if (_pollTimer.unref) _pollTimer.unref();
}

/**
 * Start periodic update checking.
 * Runs an initial check immediately (non-blocking), then polls with jittered intervals.
 */
export function startUpdateChecker(): void {
  // Initial check (non-blocking)
  checkForUpdate().catch((err) => {
    console.warn(`[UpdateChecker] Initial check failed: ${err instanceof Error ? err.message : err}`);
  });

  // Periodic polling with jitter
  scheduleNextPoll();
}

/** Stop the periodic update checker. */
export function stopUpdateChecker(): void {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}
