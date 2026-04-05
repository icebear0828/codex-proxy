import { z } from "zod";

export const ROTATION_STRATEGIES = ["least_used", "round_robin", "sticky"] as const;

export const ConfigSchema = z.object({
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
    max_concurrent_per_account: z.number().int().min(1).nullable().default(3),
    request_interval_ms: z.number().int().min(0).nullable().default(50),
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
    proxy_url: z.string().nullable().default(null),
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
    auto_download: z.boolean().default(false),
  }).default({}),
  /** Third-party API provider keys for multi-backend routing. */
  providers: z.object({
    openai: z.object({
      api_key: z.string(),
      base_url: z.string().default("https://api.openai.com/v1"),
    }).optional(),
    anthropic: z.object({
      api_key: z.string(),
    }).optional(),
    gemini: z.object({
      api_key: z.string(),
    }).optional(),
    /** OpenAI-compatible third-party providers (Groq, DeepSeek, Together, etc.). */
    custom: z.record(
      z.string(),
      z.object({
        api_key: z.string(),
        base_url: z.string(),
        models: z.array(z.string()).default([]),
      }),
    ).default({}),
  }).default({}),
  /** Explicit model → provider name routing table. */
  model_routing: z.record(z.string(), z.string()).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const FingerprintSchema = z.object({
  user_agent_template: z.string(),
  auth_domains: z.array(z.string()),
  auth_domain_exclusions: z.array(z.string()),
  header_order: z.array(z.string()),
  default_headers: z.record(z.string()).optional().default({}),
});

export type FingerprintConfig = z.infer<typeof FingerprintSchema>;
