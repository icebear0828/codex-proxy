/**
 * Config mock factories for tests.
 * Returns deep copies so tests don't pollute each other.
 */

import type { AppConfig, FingerprintConfig } from "@src/config.js";

/** Section-level partial overrides for createMockConfig. */
export interface MockConfigOverrides {
  api?: Partial<AppConfig["api"]>;
  client?: Partial<AppConfig["client"]>;
  model?: Partial<AppConfig["model"]>;
  auth?: Partial<AppConfig["auth"]>;
  server?: Partial<AppConfig["server"]>;
  session?: Partial<AppConfig["session"]>;
  tls?: Partial<AppConfig["tls"]>;
  quota?: Partial<AppConfig["quota"]>;
}

/**
 * Create a complete mock AppConfig with optional section-level overrides.
 * Each section is merged individually so you only need to specify the
 * fields you want to change, e.g. createMockConfig({ auth: { rotation_strategy: "sticky" } }).
 */
export function createMockConfig(overrides?: MockConfigOverrides): AppConfig {
  const base: AppConfig = {
    api: {
      base_url: "https://chatgpt.com/backend-api",
      timeout_seconds: 60,
    },
    client: {
      originator: "Codex Desktop",
      app_version: "260202.0859",
      build_number: "517",
      platform: "darwin",
      arch: "arm64",
      chromium_version: "136",
    },
    model: {
      default: "gpt-5.4",
      default_reasoning_effort: null,
      default_service_tier: null,
      inject_desktop_context: false,
      suppress_desktop_directives: true,
    },
    auth: {
      jwt_token: null,
      chatgpt_oauth: true,
      refresh_margin_seconds: 300,
      refresh_enabled: true,
      refresh_concurrency: 2,
      max_concurrent_per_account: 3,
      request_interval_ms: 50,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
      oauth_client_id: "app_test",
      oauth_auth_endpoint: "https://auth.openai.com/oauth/authorize",
      oauth_token_endpoint: "https://auth.openai.com/oauth/token",
    },
    server: {
      host: "0.0.0.0",
      port: 8080,
      proxy_api_key: null,
    },
    session: {
      ttl_minutes: 60,
      cleanup_interval_minutes: 5,
    },
    tls: {
      curl_binary: "auto",
      impersonate_profile: "chrome136",
      proxy_url: null,
      transport: "auto",
      force_http11: false,
    },
    quota: {
      refresh_interval_minutes: 5,
      concurrency: 10,
      warning_thresholds: {
        primary: [80, 90],
        secondary: [80, 90],
      },
      skip_exhausted: true,
    },
  };
  return structuredClone({
    api:     { ...base.api,     ...overrides?.api },
    client:  { ...base.client,  ...overrides?.client },
    model:   { ...base.model,   ...overrides?.model },
    auth:    { ...base.auth,    ...overrides?.auth },
    server:  { ...base.server,  ...overrides?.server },
    session: { ...base.session, ...overrides?.session },
    tls:     { ...base.tls,     ...overrides?.tls },
    quota:   { ...base.quota,   ...overrides?.quota },
  });
}

/** Create a complete mock FingerprintConfig with optional overrides. */
export function createMockFingerprint(overrides?: Partial<FingerprintConfig>): FingerprintConfig {
  const base: FingerprintConfig = {
    user_agent_template: "CodexDesktop/{version} ({platform}; {arch})",
    auth_domains: ["chatgpt.com"],
    auth_domain_exclusions: [],
    header_order: [
      "Authorization",
      "ChatGPT-Account-Id",
      "originator",
      "User-Agent",
      "sec-ch-ua",
      "Content-Type",
      "Accept",
      "Accept-Encoding",
      "Accept-Language",
    ],
    default_headers: {
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
  };
  return structuredClone({ ...base, ...overrides });
}
