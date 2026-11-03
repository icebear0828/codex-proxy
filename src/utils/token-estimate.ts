/**
 * Dependency-free token estimation shared by the local `count_tokens`
 * endpoints (Anthropic `/v1/messages/count_tokens`, Gemini
 * `/v1beta/models/{model}:countTokens`).
 *
 * These endpoints must never call upstream: they exist so SDKs can size a
 * request before sending it. The estimate is intentionally rough — roughly
 * one token per CJK character and one token per four other characters, plus a
 * small structural overhead — which is accurate enough for prompt budgeting
 * and avoids shipping a full tokenizer.
 */

/** Estimate tokens for a plain string. */
export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkMatches = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = Math.max(0, trimmed.length - cjkCount);

  return Math.ceil(nonCjkCount / 4) + cjkCount;
}

/** Estimate tokens for an arbitrary JSON-ish value (blocks, tools, schemas). */
export function estimateUnknownTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return estimateTextTokens(String(value));
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateUnknownTokens(item), 0) + value.length;
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, item]) => sum + estimateTextTokens(key) + estimateUnknownTokens(item),
      2,
    );
  }
  return estimateTextTokens(String(value));
}
