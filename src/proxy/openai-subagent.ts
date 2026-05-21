export const OPENAI_SUBAGENT_HEADER = "x-openai-subagent";

const ALLOWED_OPENAI_SUBAGENTS = new Set([
  "review",
  "compact",
  "memory_consolidation",
  "collab_spawn",
]);

export function normalizeOpenAISubagent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ALLOWED_OPENAI_SUBAGENTS.has(trimmed) ? trimmed : null;
}

export function sanitizeClientMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}

export function extractOpenAISubagentFromMetadata(value: unknown): string | null {
  return normalizeOpenAISubagent(sanitizeClientMetadata(value)[OPENAI_SUBAGENT_HEADER]);
}
