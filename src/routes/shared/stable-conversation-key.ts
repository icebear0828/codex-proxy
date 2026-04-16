import { createHash } from "crypto";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";

const LEADING_SYSTEM_REMINDER_RE = /^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/i;

function normalizeConversationAnchorText(text: string): string {
  return text.replace(LEADING_SYSTEM_REMINDER_RE, "").trimStart();
}

export function extractStableConversationSeed(
  req: CodexResponsesRequest,
): { instructions: string; firstUserText: string } {
  const instructions = (req.instructions ?? "").slice(0, 2000);
  const input = Array.isArray(req.input) ? req.input : [];

  let firstUserText = "";
  for (const item of input) {
    if (!("role" in item) || item.role !== "user") continue;
    const content = item.content;
    if (typeof content === "string") {
      firstUserText = content;
    } else if (Array.isArray(content)) {
      firstUserText = content
        .filter((part): part is { type: "input_text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "input_text" &&
          "text" in part &&
          typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
    break;
  }

  const normalizedFirstUserText = normalizeConversationAnchorText(firstUserText);
  return {
    instructions,
    firstUserText: normalizedFirstUserText || firstUserText,
  };
}

export function deriveStableConversationKey(req: CodexResponsesRequest): string | null {
  const { instructions, firstUserText } = extractStableConversationSeed(req);
  const model = req.model ?? "";
  if (!instructions && !firstUserText) return null;

  const seed = `${model}\x00${instructions}\x00${firstUserText}`;
  const hash = createHash("sha256").update(seed).digest("hex");

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
