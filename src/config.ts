import { readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  api: z.object({
    base_url: z.string().default("https://chatgpt.com/backend-api"),
    timeout_seconds: z.number().default(60),
  }),
  client: z.object({
    originator: z.string().default("Codex Desktop"),
    app_version: z.string().default("260202.0859"),
    build_number: z.string().default("517"),
    platform: z.string().default("darwin"),
    arch: z.string().default("arm64"),
  }),
  model: z.object({
    default: z.string().default("gpt-5.3-codex"),
    default_reasoning_effort: z.string().default("medium"),
  }),
  auth: z.object({
    jwt_token: z.string().nullable().default(null),
    chatgpt_oauth: z.boolean().default(true),
    refresh_margin_seconds: z.number().default(300),
    rotation_strategy: z.enum(["least_used", "round_robin"]).default("least_used"),
    rate_limit_backoff_seconds: z.number().default(60),
    oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann"),
    oauth_auth_endpoint: z.string().default("https://auth.openai.com/oauth/authorize"),
    oauth_token_endpoint: z.string().default("https://auth.openai.com/oauth/token"),
  }),
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().default(8080),
    proxy_api_key: z.string().nullable().default(null),
  }),
  environment: z.object({
    default_id: z.string().nullable().default(null),
    default_branch: z.string().default("main"),
  }),
  session: z.object({
    ttl_minutes: z.number().default(60),
    cleanup_interval_minutes: z.number().default(5),
  }),
  streaming: z.object({
    status_as_content: z.boolean().default(false),
    chunk_size: z.number().default(100),
    chunk_delay_ms: z.number().default(10),
    heartbeat_interval_s: z.number().default(15),
    poll_interval_s: z.number().default(2),
    timeout_s: z.number().default(300),
  }),
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

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  if (process.env.CODEX_JWT_TOKEN) {
    (raw.auth as Record<string, unknown>).jwt_token = process.env.CODEX_JWT_TOKEN;
  }
  if (process.env.CODEX_PLATFORM) {
    (raw.client as Record<string, unknown>).platform = process.env.CODEX_PLATFORM;
  }
  if (process.env.CODEX_ARCH) {
    (raw.client as Record<string, unknown>).arch = process.env.CODEX_ARCH;
  }
  if (process.env.PORT) {
    (raw.server as Record<string, unknown>).port = parseInt(process.env.PORT, 10);
  }
  return raw;
}

let _config: AppConfig | null = null;
let _fingerprint: FingerprintConfig | null = null;

export function loadConfig(configDir?: string): AppConfig {
  if (_config) return _config;
  const dir = configDir ?? resolve(process.cwd(), "config");
  const raw = loadYaml(resolve(dir, "default.yaml")) as Record<string, unknown>;
  applyEnvOverrides(raw);
  _config = ConfigSchema.parse(raw);
  return _config;
}

export function loadFingerprint(configDir?: string): FingerprintConfig {
  if (_fingerprint) return _fingerprint;
  const dir = configDir ?? resolve(process.cwd(), "config");
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

export function mutateClientConfig(patch: Partial<AppConfig["client"]>): void {
  if (!_config) throw new Error("Config not loaded");
  Object.assign(_config.client, patch);
}
