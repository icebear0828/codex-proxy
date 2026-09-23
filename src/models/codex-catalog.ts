/**
 * Codex-native rich catalog serializer.
 *
 * Emits the payload shape the Codex CLI's ModelsClient decodes (`ModelsResponse`
 * wrapping codex-rs protocol `ModelInfo`): required keys are slug, display_name,
 * supported_reasoning_levels, shell_type, visibility, supported_in_api, priority,
 * support_verbosity and truncation_policy; everything else is defaulted so
 * static entries and runtime-discovered models stay decodable downstream.
 */

import type { CodexModelInfo } from "./model-store.js";

/** Tool-output truncation default for entries the backend reported no policy for. */
const FALLBACK_TRUNCATION = { mode: "bytes", limit: 10_000 } as const;

export function toCodexCatalogEntry(info: CodexModelInfo) {
  const upgrade = info.upgradeInfo
    ? {
        model: info.upgradeInfo.model,
        migration_markdown: info.upgradeInfo.migration_markdown ?? "",
        ...(info.upgradeInfo.retirement_at !== undefined && {
          retirement_at: info.upgradeInfo.retirement_at,
        }),
      }
    : null;

  return {
    // `id` mirrors slug so non-CLI consumers can key entries like on /v1/models.
    id: info.id,
    slug: info.id,
    display_name: info.displayName || info.id,
    description: info.description || null,
    default_reasoning_level: info.defaultReasoningEffort ?? null,
    supported_reasoning_levels: (info.supportedReasoningEfforts ?? []).map((effort) => ({
      effort: effort.reasoningEffort,
      description: effort.description,
    })),
    shell_type: info.shellType ?? "unified_exec",
    visibility: info.visibility ?? "list",
    supported_in_api: info.supportedInApi ?? true,
    priority: info.priority ?? 99,
    additional_speed_tiers: info.additionalSpeedTiers ?? [],
    // CLI decodes ModelServiceTier with required string id/name/description —
    // fill gaps instead of passing partial tiers through.
    service_tiers: (info.serviceTiers ?? []).map((tier) => ({
      id: String(tier?.id ?? ""),
      name: String(tier?.name ?? tier?.id ?? ""),
      description: String(tier?.description ?? ""),
    })),
    default_service_tier: info.defaultServiceTier ?? null,
    available_access_programs: null,
    availability_nux: null,
    upgrade,
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: info.supportsReasoningSummaryParameter ?? true,
    default_reasoning_summary: info.defaultReasoningSummary ?? "auto",
    support_verbosity: info.supportVerbosity ?? false,
    default_verbosity: info.defaultVerbosity ?? null,
    apply_patch_tool_type: info.applyPatchToolType ?? null,
    web_search_tool_type: info.webSearchToolType ?? "text",
    truncation_policy: info.truncationPolicyLimit !== undefined
      ? { mode: info.truncationPolicyMode ?? "tokens", limit: info.truncationPolicyLimit }
      : FALLBACK_TRUNCATION,
    supports_image_detail_original: false,
    context_window: info.contextWindow ?? null,
    max_context_window: info.maxContextWindow ?? null,
    auto_compact_token_limit: info.autoCompactTokenLimit ?? null,
    comp_hash: info.compHash ?? null,
    effective_context_window_percent: info.effectiveContextWindowPercent ?? 95,
    experimental_supported_tools: info.experimentalSupportedTools ?? [],
    input_modalities: info.inputModalities ?? ["text", "image"],
    supports_search_tool: info.supportsSearchTool ?? false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    guardian: null,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: info.modelSpecialty ?? null,
    tool_mode: info.toolMode ?? null,
    multi_agent_version: info.multiAgentVersion ?? null,
    multi_agent_reasoning_effort: info.multiAgentReasoningEffort ?? null,
  };
}
