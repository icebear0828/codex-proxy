/**
 * Update checker — polls the Codex Sparkle appcast for new versions.
 * Automatically applies version updates to config file and runtime.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { mutateClientConfig } from "./config.js";
import { jitterInt } from "./utils/jitter.js";
import { curlFetchGet } from "./tls/curl-fetch.js";

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
  let content = readFileSync(CONFIG_PATH, "utf-8");
  content = content.replace(/app_version:\s*"[^"]+"/, `app_version: "${version}"`);
  content = content.replace(/build_number:\s*"[^"]+"/, `build_number: "${build}"`);
  writeFileSync(CONFIG_PATH, content, "utf-8");
  mutateClientConfig({ app_version: version, build_number: build });
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
