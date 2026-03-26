import { resolve } from "path";
import { loadStaticModels } from "./models/model-store.js";
import { triggerImmediateRefresh } from "./models/model-fetcher.js";
import { getConfigDir, getDataDir } from "./paths.js";
import { ConfigSchema, FingerprintSchema } from "./config-schema.js";
import { loadYaml, loadMergedConfig, applyEnvOverrides } from "./config-loader.js";
import type { AppConfig, FingerprintConfig } from "./config-schema.js";

// Re-export schema, types, and constants so all existing importers keep working
export { ROTATION_STRATEGIES, ConfigSchema, FingerprintSchema } from "./config-schema.js";
export type { AppConfig, FingerprintConfig } from "./config-schema.js";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _config: AppConfig | null = null;
let _fingerprint: FingerprintConfig | null = null;
let _localOverrides: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Load (first-call initialisation)
// ---------------------------------------------------------------------------

export function loadConfig(configDir?: string): AppConfig {
  if (_config) return _config;
  const { raw, local } = loadMergedConfig(configDir);
  applyEnvOverrides(raw, local);
  _localOverrides = local;
  _config = ConfigSchema.parse(raw);
  return _config;
}

export function loadFingerprint(configDir?: string): FingerprintConfig {
  if (_fingerprint) return _fingerprint;
  const dir = configDir ?? getConfigDir();
  const raw = loadYaml(resolve(dir, "fingerprint.yaml"));
  _fingerprint = FingerprintSchema.parse(raw);
  return _fingerprint;
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getConfig(): AppConfig {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}

export function getFingerprint(): FingerprintConfig {
  if (!_fingerprint) throw new Error("Fingerprint not loaded. Call loadFingerprint() first.");
  return _fingerprint;
}

/** Path to the local overlay config file (data/local.yaml). */
export function getLocalConfigPath(): string {
  return resolve(getDataDir(), "local.yaml");
}

/**
 * Check whether a config key was explicitly set in data/local.yaml.
 * Usage: hasLocalOverride("server", "host") → true if local.yaml contains server.host
 */
export function hasLocalOverride(...path: string[]): boolean {
  let obj: unknown = _localOverrides;
  for (const key of path) {
    if (obj === null || obj === undefined || typeof obj !== "object") return false;
    obj = (obj as Record<string, unknown>)[key];
  }
  return obj !== undefined;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export function mutateClientConfig(patch: Partial<AppConfig["client"]>): void {
  if (!_config) throw new Error("Config not loaded");
  Object.assign(_config.client, patch);
}

// ---------------------------------------------------------------------------
// Reload (hot-reload after self-update)
// ---------------------------------------------------------------------------

/** Reload config from disk (hot-reload after full-update).
 *  P1-5: Load to temp first, then swap atomically to avoid null window. */
export function reloadConfig(configDir?: string): AppConfig {
  const { raw, local } = loadMergedConfig(configDir);
  applyEnvOverrides(raw, local);
  _localOverrides = local;
  const fresh = ConfigSchema.parse(raw);
  _config = fresh;
  return _config;
}

/** Reload fingerprint from disk (hot-reload after full-update).
 *  P1-5: Load to temp first, then swap atomically. */
export function reloadFingerprint(configDir?: string): FingerprintConfig {
  const dir = configDir ?? getConfigDir();
  const raw = loadYaml(resolve(dir, "fingerprint.yaml"));
  const fresh = FingerprintSchema.parse(raw);
  _fingerprint = fresh;
  return _fingerprint;
}

/** Reload both config and fingerprint from disk, plus static models. */
export function reloadAllConfigs(configDir?: string): void {
  reloadConfig(configDir);
  reloadFingerprint(configDir);
  loadStaticModels(configDir);
  console.log("[Config] Hot-reloaded config, fingerprint, and models from disk");
  // Re-merge backend models so hot-reload doesn't wipe them for ~1h
  triggerImmediateRefresh();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test-only: replace the config singleton. Production code MUST NOT call this. */
export function setConfigForTesting(config: AppConfig): void {
  _config = config;
}

/** Test-only: reset config and fingerprint singletons. */
export function resetConfigForTesting(): void {
  _config = null;
  _fingerprint = null;
}
