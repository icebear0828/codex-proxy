/**
 * Update checker — polls the Codex Sparkle appcast for new versions.
 * Integrates with the main server process.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

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
let _pollTimer: ReturnType<typeof setInterval> | null = null;

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
  const versionMatch = item.match(/sparkle:shortVersionString="([^"]+)"/);
  const buildMatch = item.match(/sparkle:version="([^"]+)"/);
  const urlMatch = item.match(/url="([^"]+)"/);
  return {
    version: versionMatch?.[1] ?? null,
    build: buildMatch?.[1] ?? null,
    downloadUrl: urlMatch?.[1] ?? null,
  };
}

export async function checkForUpdate(): Promise<UpdateState> {
  const current = loadCurrentConfig();
  const res = await fetch(APPCAST_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch appcast: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
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
  }

  return state;
}

/** Get the most recent update check state. */
export function getUpdateState(): UpdateState | null {
  return _currentState;
}

/**
 * Start periodic update checking.
 * Runs an initial check immediately (non-blocking), then polls every 30 minutes.
 */
export function startUpdateChecker(): void {
  // Initial check (non-blocking)
  checkForUpdate().catch((err) => {
    console.warn(`[UpdateChecker] Initial check failed: ${err instanceof Error ? err.message : err}`);
  });

  // Periodic polling
  _pollTimer = setInterval(() => {
    checkForUpdate().catch((err) => {
      console.warn(`[UpdateChecker] Poll failed: ${err instanceof Error ? err.message : err}`);
    });
  }, POLL_INTERVAL_MS);

  // Don't keep the process alive just for update checks
  if (_pollTimer.unref) _pollTimer.unref();
}

/** Stop the periodic update checker. */
export function stopUpdateChecker(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
