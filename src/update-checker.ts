/**
 * Update checker — polls the Codex Sparkle appcast for new versions.
 * Automatically applies version updates to config file and runtime.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { fork } from "child_process";
import yaml from "js-yaml";
import { mutateClientConfig, reloadAllConfigs } from "./config.js";
import { jitterInt } from "./utils/jitter.js";
import { curlFetchGet } from "./tls/curl-fetch.js";
import { mutateYaml } from "./utils/yaml-mutate.js";

const CONFIG_PATH = resolve(process.cwd(), "config/default.yaml");
const STATE_PATH = resolve(process.cwd(), "data/update-state.json");
const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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

function loadCurrentConfig(): { app_version: string; build_number: string } {
  const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  const client = raw.client as Record<string, string>;
  return {
    app_version: client.app_version,
    build_number: client.build_number,
  };
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
  mutateYaml(CONFIG_PATH, (data: any) => {
    data.client.app_version = version;
    data.client.build_number = build;
  });
  mutateClientConfig({ app_version: version, build_number: build });
}

/**
 * Trigger the full-update pipeline in a background child process.
 * Downloads new Codex.app, extracts fingerprint, and applies config updates.
 * Protected by a lock to prevent concurrent runs.
 */
function triggerFullUpdate(): void {
  if (_updateInProgress) {
    console.log("[UpdateChecker] Full update already in progress, skipping");
    return;
  }
  _updateInProgress = true;
  console.log("[UpdateChecker] Triggering full-update pipeline...");

  const child = fork(
    resolve(process.cwd(), "scripts/full-update.ts"),
    ["--force"],
    {
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      cwd: process.cwd(),
    },
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  child.on("exit", (code) => {
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
    mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
