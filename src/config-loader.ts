import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfigDir, getDataDir } from "./paths.js";

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
