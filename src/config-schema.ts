import { z } from "zod";

export const ROTATION_STRATEGIES = ["least_used", "round_robin", "sticky"] as const;

// Note: discriminatedUnion does not accept ZodEffects branches, so the
// presence-of-secret-material checks are applied at the union level via
// superRefine rather than per-branch.
const OfficialAgentAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("capability_token"),
    token: z.string().trim().min(1).optional(),
    token_file: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("signed_bearer_token"),
    shared_secret: z.string().trim().min(1).optional(),
    shared_secret_file: z.string().trim().min(1).optional(),
    issuer: z.string().trim().min(1).default("codex-proxy"),
    audience: z.string().trim().min(1).default("codex-app-server"),
    subject: z.string().trim().min(1).default("codex-proxy"),
    ttl_seconds: z.number().int().min(30).max(3600).default(300),
  }),
]).superRefine((value, ctx) => {
  if (value.type === "capability_token" && !value.token && !value.token_file) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capability_token auth requires token or token_file",
      path: ["token"],
    });
  }
  if (value.type === "signed_bearer_token" && !value.shared_secret && !value.shared_secret_file) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "signed_bearer_token auth requires shared_secret or shared_secret_file",
      path: ["shared_secret"],
    });
  }
});

const CustomModelSchema = z.union([
  z.string().trim().min(1),
  z.object({
    id: z.string().trim().min(1),
    display_name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    supported_reasoning_efforts: z.array(z.string().trim().min(1)).optional(),
    default_reasoning_effort: z.string().trim().min(1).optional(),
    input_modalities: z.array(z.string().trim().min(1)).optional(),
    output_modalities: z.array(z.string().trim().min(1)).optional(),
    supports_personality: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
    max_context_window: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    truncation_policy_limit: z.number().int().positive().optional(),
  }),
]);

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

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
    default: z.string().default("gpt-5.4"),
    default_reasoning_effort: z.string().nullable().default(null),
    default_service_tier: z.string().nullable().default(null),
    aliases: z.record(z.string(), z.string()).default({}),
    custom_models: z.array(CustomModelSchema).default([]),
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
    /** Preferred plan-type ordering for account selection (e.g. ["plus","team","free"]). */
    tier_priority: z.array(z.string()).nullable().default(null),
    rate_limit_backoff_seconds: z.number().min(1).default(60),
    oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann"),
    oauth_auth_endpoint: z.string().default("https://auth.openai.com/oauth/authorize"),
    oauth_token_endpoint: z.string().default("https://auth.openai.com/oauth/token"),
  }),
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().min(1).max(65535).default(8080),
    proxy_api_key: z.string().nullable().default(null),
    trust_proxy: z.boolean().default(false),
  }),
  logs: z.object({
    enabled: z.boolean().default(false),
    capacity: z.number().int().min(1).default(2000),
    capture_body: z.boolean().default(false),
    llm_only: z.boolean().default(true),
  }).default({}),
  // Local observability (no third-party SaaS). v1 ships a local
  // uncaught-error log; future iterations may add remote upload here.
  observability: z.object({
    local_error_log: z.boolean().default(true),
    max_log_bytes: z.number().int().min(1024).default(10 * 1024 * 1024),
  }).default({}),
  usage_stats: z.object({
    /** How often to record local usage history snapshots. 0 disables history recording. */
    snapshot_interval_minutes: z.number().int().min(0).default(5),
    /** null means keep usage history forever. */
    history_retention_days: z.number().int().positive().nullable().default(null),
  }).default({}),
  session: z.object({
    ttl_minutes: z.number().min(1).default(1440),
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
    show_update_dialog: z.boolean().default(false),
    allow_prerelease: z.boolean().default(false),
  }).default({}),
  /** WebSocket connection pool — pins same (entryId, conversationId) to the
   *  same physical WS so the upstream LB keeps prompt cache warm across
   *  turns. See `src/proxy/ws-pool.ts` for the rationale. */
  ws_pool: z.object({
    enabled: z.boolean().default(true),
    /** Hard upper bound per connection. Server enforces a 60-min cap; we
     *  close 5 min early to avoid disrupting in-flight requests. */
    max_age_ms: z.number().int().positive().default(3_300_000),
    /** Cap on concurrent pooled connections per account, to bound memory
     *  when a user opens many parallel conversations. */
    max_per_account: z.number().int().positive().default(8),
  }).default({}),
  ollama: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().min(1).max(65535).default(11434),
    version: z.string().trim().min(1).max(64).default("0.18.3"),
    disable_vision: z.boolean().default(false),
  }).default({}),
  /** Optional bridge to official local `codex app-server` for Codex app plugins,
   * including the official Chrome/browser automation plugin. */
  official_agent: z.object({
    enabled: z.boolean().default(false),
    api_key: z.string().trim().min(1).nullable().default(null),
    app_server_url: z.string().trim().refine(isWebSocketUrl, {
      message: "app_server_url must be a ws:// or wss:// URL",
    }).default("ws://127.0.0.1:4500"),
    request_timeout_ms: z.number().int().min(1000).max(300000).default(30000),
    auth: OfficialAgentAuthSchema.default({ type: "none" }),
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
