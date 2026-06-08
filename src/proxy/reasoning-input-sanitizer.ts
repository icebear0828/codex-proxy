import type {
  CodexCompactionItem,
  CodexInputItem,
  CodexReasoningItem,
  CodexReasoningStatus,
  CodexReasoningSummaryPart,
  CodexReasoningTextPart,
} from "./codex-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function isReasoningStatus(value: unknown): value is CodexReasoningStatus {
  return value === "in_progress" || value === "completed" || value === "incomplete";
}

function sanitizeSummary(value: unknown): CodexReasoningSummaryPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): CodexReasoningSummaryPart[] => {
    if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      return [];
    }
    return [{ type: "summary_text", text: part.text }];
  });
  return parts.length > 0 ? parts : undefined;
}

function sanitizeContent(value: unknown): CodexReasoningTextPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): CodexReasoningTextPart[] => {
    if (!isRecord(part) || part.type !== "reasoning_text" || typeof part.text !== "string") {
      return [];
    }
    return [{ type: "reasoning_text", text: part.text }];
  });
  return parts.length > 0 ? parts : undefined;
}

function sanitizeReasoningItem(item: Record<string, unknown>): CodexReasoningItem {
  const sanitized: CodexReasoningItem = { type: "reasoning" };
  const id = nonEmptyString(item.id);
  if (id) sanitized.id = id;
  if (isReasoningStatus(item.status)) sanitized.status = item.status;
  const encryptedContent = nonEmptyString(item.encrypted_content);
  if (encryptedContent) sanitized.encrypted_content = encryptedContent;
  const summary = sanitizeSummary(item.summary);
  if (summary) sanitized.summary = summary;
  const content = sanitizeContent(item.content);
  if (content) sanitized.content = content;
  return sanitized;
}

function sanitizeCompactionItem(item: Record<string, unknown>): CodexCompactionItem | null {
  const encryptedContent = nonEmptyString(item.encrypted_content);
  if (!encryptedContent) return null;
  const sanitized: CodexCompactionItem = { type: "compaction", encrypted_content: encryptedContent };
  const id = nonEmptyString(item.id);
  if (id) sanitized.id = id;
  const createdBy = nonEmptyString(item.created_by);
  if (createdBy) sanitized.created_by = createdBy;
  return sanitized;
}

export function sanitizeCodexInputItems(input: unknown[]): CodexInputItem[] {
  return input.flatMap((item): CodexInputItem[] => {
    if (!isRecord(item)) return [item as CodexInputItem];
    if (item.type === "reasoning") return [sanitizeReasoningItem(item)];
    if (item.type === "compaction") {
      const sanitized = sanitizeCompactionItem(item);
      return sanitized ? [sanitized] : [];
    }
    return [item as CodexInputItem];
  });
}
