import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfigDir, getDataDir } from "./paths.js";

const CLIENT_VERSION_KEYS = ["app_version", "build_number", "chromium_version"] as const;
type ClientVersionKey = typeof CLIENT_VERSION_KEYS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function loadYaml(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");
  return yaml.load(content);
}

/** Deep merge source into target. Source values win. Arrays are replaced, not merged. */
export function deepMerge(
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

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasLocalClientOverride(
  local: Record<string, unknown> | null,
  key: ClientVersionKey,
): boolean {
  const client = local?.client;
  return isRecord(client) && client[key] !== undefined;
}

function readLocalClientOverride(
  local: Record<string, unknown> | null,
  key: ClientVersionKey,
): string | null {
  const client = local?.client;
  if (!isRecord(client) || client[key] === undefined) return null;
  return asNonEmptyString(client[key]);
}

function applyClientValue(
  client: Record<string, unknown>,
  local: Record<string, unknown> | null,
  key: ClientVersionKey,
  value: string | null,
): void {
  if (!value || hasLocalClientOverride(local, key)) return;
  client[key] = value;
}

function readExtractedChromiumVersion(
  dataDir: string,
  appVersion: string,
  buildNumber: string,
): string | null {
  const extracted = readJsonRecord(resolve(dataDir, "extracted-fingerprint.json"));
  if (!extracted) return null;
  if (asNonEmptyString(extracted.app_version) !== appVersion) return null;
  if (asNonEmptyString(extracted.build_number) !== buildNumber) return null;
  return asNonEmptyString(extracted.chromium_version);
}

function applyPersistedClientVersionState(
  raw: Record<string, unknown>,
  local: Record<string, unknown> | null,
  dataDir: string,
): void {
  const state = readJsonRecord(resolve(dataDir, "version-state.json"));
  if (!state) return;

  const persistedAppVersion = asNonEmptyString(state.app_version);
  const persistedBuildNumber = asNonEmptyString(state.build_number);
  if (!persistedAppVersion || !persistedBuildNumber) return;

  const client: Record<string, unknown> = isRecord(raw.client) ? raw.client : {};
  raw.client = client;

  const effectiveAppVersion = hasLocalClientOverride(local, "app_version")
    ? readLocalClientOverride(local, "app_version")
    : persistedAppVersion;
  const effectiveBuildNumber = hasLocalClientOverride(local, "build_number")
    ? readLocalClientOverride(local, "build_number")
    : persistedBuildNumber;

  const stateMatchesEffectiveVersion =
    effectiveAppVersion === persistedAppVersion &&
    effectiveBuildNumber === persistedBuildNumber;
  const chromiumVersion = effectiveAppVersion && effectiveBuildNumber
    ? (
      stateMatchesEffectiveVersion ? asNonEmptyString(state.chromium_version) : null
    ) ?? readExtractedChromiumVersion(dataDir, effectiveAppVersion, effectiveBuildNumber)
    : null;

  applyClientValue(client, local, "app_version", persistedAppVersion);
  applyClientValue(client, local, "build_number", persistedBuildNumber);
  applyClientValue(client, local, "chromium_version", chromiumVersion);
}

/** Load default.yaml and merge data/local.yaml overlay (if exists). */
export function loadMergedConfig(configDir?: string): {
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
  applyPersistedClientVersionState(raw, local, dataDir);
  return { raw, local };
}

export function applyEnvOverrides(
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
  const corsAllowedHosts = process.env.CORS_ALLOWED_HOSTS?.trim();
  if (corsAllowedHosts) {
    if (!raw.server) raw.server = {};
    (raw.server as Record<string, unknown>).cors = corsAllowedHosts
      .split(",")
      .map((h: string) => h.trim())
      .filter((h: string) => h.length > 0);
  }
  const serverHostEnv = process.env.CODEX_PROXY_HOST?.trim();
  const localServer = localOverrides?.server as Record<string, unknown> | undefined;
  const localHasServerHost = localServer !== undefined && "host" in localServer;
  if (serverHostEnv && !localHasServerHost) {
    if (!raw.server) raw.server = {};
    (raw.server as Record<string, unknown>).host = serverHostEnv;
  }
  const ollamaEnabledEnv = process.env.OLLAMA_BRIDGE_ENABLED?.trim().toLowerCase();
  const ollamaHostEnv = process.env.OLLAMA_BRIDGE_HOST?.trim();
  const ollamaPortEnv = process.env.OLLAMA_BRIDGE_PORT?.trim();
  const ollamaVersionEnv = process.env.OLLAMA_BRIDGE_VERSION?.trim();
  const ollamaDisableVisionEnv = process.env.OLLAMA_BRIDGE_DISABLE_VISION?.trim().toLowerCase();
  if (ollamaEnabledEnv || ollamaHostEnv || ollamaPortEnv || ollamaVersionEnv || ollamaDisableVisionEnv) {
    if (!raw.ollama) raw.ollama = {};
    const ollama = raw.ollama as Record<string, unknown>;
    if (ollamaEnabledEnv) {
      ollama.enabled = ["1", "true", "yes"].includes(ollamaEnabledEnv);
    }
    if (ollamaHostEnv) {
      ollama.host = ollamaHostEnv;
    }
    if (ollamaPortEnv) {
      const parsed = parseInt(ollamaPortEnv, 10);
      if (!isNaN(parsed)) {
        ollama.port = parsed;
      }
    }
    if (ollamaVersionEnv) {
      ollama.version = ollamaVersionEnv;
    }
    if (ollamaDisableVisionEnv) {
      ollama.disable_vision = ["1", "true", "yes"].includes(ollamaDisableVisionEnv);
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
