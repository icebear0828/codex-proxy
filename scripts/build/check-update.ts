#!/usr/bin/env tsx
/**
 * check-update.ts — Polls the Codex Sparkle appcast feed for new versions.
 *
 * Usage:
 *   npx tsx scripts/build/check-update.ts [--watch]
 *
 * With --watch: polls every 30 minutes and keeps running.
 * Without: runs once and exits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import yaml from "js-yaml";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CONFIG_PATH = resolve(ROOT, "config/default.yaml");
const VERSION_OVERRIDE_PATH = resolve(ROOT, "data/version-state.json");
const STATE_PATH = resolve(ROOT, "data/update-state.json");
const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const POLL_INTERVAL_MS = 30 * 60 * 1000;

interface UpdateState {
  last_check: string;
  latest_version: string | null;
  latest_build: string | null;
  download_url: string | null;
  update_available: boolean;
  current_version: string;
  current_build: string;
}

interface CurrentConfig {
  app_version: string;
  build_number: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function loadCurrentConfig(): CurrentConfig {
  if (existsSync(VERSION_OVERRIDE_PATH)) {
    const override = asRecord(JSON.parse(readFileSync(VERSION_OVERRIDE_PATH, "utf-8")) as unknown, VERSION_OVERRIDE_PATH);
    return {
      app_version: stringField(override, "app_version"),
      build_number: stringField(override, "build_number"),
    };
  }

  const raw = asRecord(yaml.load(readFileSync(CONFIG_PATH, "utf-8")), CONFIG_PATH);
  const client = asRecord(raw.client, "client");
  return {
    app_version: stringField(client, "app_version"),
    build_number: stringField(client, "build_number"),
  };
}

/**
 * Parse appcast XML to extract version info.
 * Uses regex-based parsing to avoid heavy XML dependencies.
 */
export function parseCheckUpdateAppcast(xml: string): {
  version: string | null;
  build: string | null;
  downloadUrl: string | null;
} {
  const itemMatch = /<item>([\s\S]*?)<\/item>/i.exec(xml);
  if (!itemMatch) return { version: null, build: null, downloadUrl: null };

  const item = itemMatch[1];

  const versionMatch =
    /sparkle:shortVersionString="([^"]+)"/.exec(item) ??
    /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(item);
  const buildMatch =
    /sparkle:version="([^"]+)"/.exec(item) ??
    /<sparkle:version>([^<]+)<\/sparkle:version>/.exec(item);
  const urlMatch = /url="([^"]+)"/.exec(item);

  return {
    version: versionMatch?.[1] ?? null,
    build: buildMatch?.[1] ?? null,
    downloadUrl: urlMatch?.[1] ?? null,
  };
}

async function checkOnce(): Promise<UpdateState> {
  const current = loadCurrentConfig();

  console.log(`[check-update] Current: v${current.app_version} (build ${current.build_number})`);
  console.log(`[check-update] Fetching ${APPCAST_URL}...`);

  const res = await fetch(APPCAST_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch appcast: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  const { version, build, downloadUrl } = parseCheckUpdateAppcast(xml);

  if (!version || !build) {
    console.warn("[check-update] Could not parse version from appcast");
    return {
      last_check: new Date().toISOString(),
      latest_version: null,
      latest_build: null,
      download_url: null,
      update_available: false,
      current_version: current.app_version,
      current_build: current.build_number,
    };
  }

  const updateAvailable =
    version !== current.app_version || build !== current.build_number;

  const state: UpdateState = {
    last_check: new Date().toISOString(),
    latest_version: version,
    latest_build: build,
    download_url: downloadUrl,
    update_available: updateAvailable,
    current_version: current.app_version,
    current_build: current.build_number,
  };

  if (updateAvailable) {
    console.log(`\n  *** UPDATE AVAILABLE ***`);
    console.log(`  New version: ${version} (build ${build})`);
    console.log(`  Current:     ${current.app_version} (build ${current.build_number})`);
    if (downloadUrl) {
      console.log(`  Download:    ${downloadUrl}`);
    }
    console.log("[check-update] Run: npm run update -- --path <Codex.app or extracted ASAR dir>");
  } else {
    console.log(`[check-update] Up to date: v${version} (build ${build})`);
  }

  // Write state
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  console.log(`[check-update] State written to ${STATE_PATH}`);

  return state;
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");

  await checkOnce();

  if (watch) {
    console.log(`[check-update] Watching every ${POLL_INTERVAL_MS / 60000} minutes...`);
    setInterval(() => {
      void checkOnce().catch((error: unknown) => {
        console.error("[check-update] Poll error:", error instanceof Error ? error.message : error);
      });
    }, POLL_INTERVAL_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("[check-update] Fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
