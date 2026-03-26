import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { z } from "zod";
import { loadStaticModels } from "./models/model-store.js";
import { triggerImmediateRefresh } from "./models/model-fetcher.js";
import { getConfigDir, getDataDir } from "./paths.js";

export const ROTATION_STRATEGIES = ["least_used", "round_robin", "sticky"] as const;

const ConfigSchema = z.object({
  api: z.object({
    base_url: z.string().default("https://chatgpt.com/backend-api"),
    timeout_seconds: z.number().min(1).default(60),
  }),
  client: z.object({
    originator: z.string().default("Codex Desktop"),
    app_version: z.string().default("260202.0859"),
    build_number: z.string().default("517"),
    platform: z.string().default("darwin"),
    arch: z.string().default("arm64"),
    chromium_version: z.string().default("136"),
  }),
  model: z.object({
    default: z.string().default("gpt-5.2-codex"),
    default_reasoning_effort: z.string().default("medium"),
    default_service_tier: z.string().nullable().default(null),
    inject_desktop_context: z.boolean().default(false),
    suppress_desktop_directives: z.boolean().default(true),
  }),
  auth: z.object({
    jwt_token: z.string().nullable().default(null),
    chatgpt_oauth: z.boolean().default(true),
    refresh_margin_seconds: z.number().min(0).default(300),
    refresh_enabled: z.boolean().default(true),
    refresh_concurrency: z.number().int().min(1).default(2),
    rotation_strategy: z.enum(ROTATION_STRATEGIES).default("least_used"),
    rate_limit_backoff_seconds: z.number().min(1).default(60),
    oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann"),
    oauth_auth_endpoint: z.string().default("https://auth.openai.com/oauth/authorize"),
    oauth_token_endpoint: z.string().default("https://auth.openai.com/oauth/token"),
  }),
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().min(1).max(65535).default(8080),
    proxy_api_key: z.string().nullable().default(null),
  }),
  session: z.object({
    ttl_minutes: z.number().min(1).default(60),
    cleanup_interval_minutes: z.number().min(1).default(5),
  }),
  tls: z.object({
    curl_binary: z.string().default("auto"),
    impersonate_profile: z.string().default("chrome136"),
    proxy_url: z.string().nullable().default(null),
    transport: z.enum(["auto", "curl-cli", "libcurl-ffi"]).default("auto"),
    force_http11: z.boolean().default(false),
  }).default({}),
  quota: z.object({
    refresh_interval_minutes: z.number().min(0).default(5),
    concurrency: z.number().int().min(1).default(10),
    warning_thresholds: z.object({
      primary: z.array(z.number().min(1).max(100)).default([80, 90]),
      secondary: z.array(z.number().min(1).max(100)).default([80, 90]),
    }).default({}),
    skip_exhausted: z.boolean().default(true),
  }).default({}),
  update: z.object({
    auto_update: z.boolean().default(true),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const FingerprintSchema = z.object({
  user_agent_template: z.string(),
  auth_domains: z.array(z.string()),
  auth_domain_exclusions: z.array(z.string()),
  header_order: z.array(z.string()),
  default_headers: z.record(z.string()).optional().default({}),
});

export type FingerprintConfig = z.infer<typeof FingerprintSchema>;

function loadYaml(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");
  return yaml.load(content);
}

/** Deep merge source into target. Source values win. Arrays are replaced, not merged. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
      tv !== null && typeof tv === "object" && !Array.isArray(tv)
    ) {
      target[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      target[key] = sv;
    }
  }
  return target;
}

/** Load default.yaml and merge data/local.yaml overlay (if exists). */
function loadMergedConfig(configDir?: string): {
  raw: Record<string, unknown>;
  local: Record<string, unknown> | null;
} {
  const dir = configDir ?? getConfigDir();
  const raw = loadYaml(resolve(dir, "default.yaml")) as Record<string, unknown>;
  // When a custom configDir is provided (tests), look for local.yaml alongside it;
  // otherwise use the standard data directory.
  const dataDir = configDir ? resolve(configDir, "..", "data") : getDataDir();
  const localPath = resolve(dataDir, "local.yaml");
  if (!existsSync(localPath)) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(localPath, "server:\n  proxy_api_key: pwd\n", "utf-8");
      console.log("[Config] Created data/local.yaml with default proxy_api_key");
    } catch (err) {
      console.warn(`[Config] Failed to create data/local.yaml: ${err instanceof Error ? err.message : err}`);
    }
  }
  let local: Record<string, unknown> | null = null;
  if (existsSync(localPath)) {
    try {
      const loaded = loadYaml(localPath) as Record<string, unknown> | null;
      if (loaded && typeof loaded === "object") {
        local = loaded;
        deepMerge(raw, loaded);
        console.log("[Config] Merged local overrides from data/local.yaml");
      }
    } catch (err) {
      console.warn(`[Config] Failed to load data/local.yaml: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { raw, local };
}

function applyEnvOverrides(
  raw: Record<string, unknown>,
  localOverrides: Record<string, unknown> | null,
): Record<string, unknown> {
  const jwtEnv = process.env.CODEX_JWT_TOKEN?.trim();
  if (jwtEnv && jwtEnv.startsWith("eyJ")) {
    (raw.auth as Record<string, unknown>).jwt_token = jwtEnv;
  } else if (jwtEnv) {
    console.warn("[Config] CODEX_JWT_TOKEN ignored: not a valid JWT (must start with 'eyJ')");
  }
  if (process.env.CODEX_PLATFORM) {
    (raw.client as Record<string, unknown>).platform = process.env.CODEX_PLATFORM;
  }
  if (process.env.CODEX_ARCH) {
    (raw.client as Record<string, unknown>).arch = process.env.CODEX_ARCH;
  }
  if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed)) {
      (raw.server as Record<string, unknown>).port = parsed;
    }
  }
  // Only apply HTTPS_PROXY env if user hasn't explicitly set proxy_url in local.yaml
  const localTls = localOverrides?.tls as Record<string, unknown> | undefined;
  const localHasProxyUrl = localTls !== undefined && "proxy_url" in localTls;
  if (!localHasProxyUrl) {
    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxyEnv) {
      if (!raw.tls) raw.tls = {};
      (raw.tls as Record<string, unknown>).proxy_url = proxyEnv;
    }
  }
  return raw;
}

let _config: AppConfig | null = null;
let _fingerprint: FingerprintConfig | null = null;
let _localOverrides: Record<string, unknown> | null = null;

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

/** Test-only: replace the config singleton. Production code MUST NOT call this. */
export function setConfigForTesting(config: AppConfig): void {
  _config = config;
}

/** Test-only: reset config and fingerprint singletons. */
export function resetConfigForTesting(): void {
  _config = null;
  _fingerprint = null;
}

export function mutateClientConfig(patch: Partial<AppConfig["client"]>): void {
  if (!_config) throw new Error("Config not loaded");
  Object.assign(_config.client, patch);
}

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
