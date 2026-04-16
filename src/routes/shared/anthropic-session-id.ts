import type { AnthropicMessagesRequest } from "../../types/anthropic.js";

function parseMetadataSessionId(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown; device_id?: unknown };
    return typeof parsed.session_id === "string" &&
      parsed.session_id &&
      typeof parsed.device_id === "string" &&
      parsed.device_id
      ? parsed.session_id
      : null;
  } catch {
    return null;
  }
}

export function extractAnthropicClientConversationId(
  req: AnthropicMessagesRequest,
  headerSessionId: string | undefined,
): string | null {
  const normalizedHeaderSessionId = headerSessionId?.trim();
  if (normalizedHeaderSessionId) return normalizedHeaderSessionId;
  return parseMetadataSessionId(req.metadata?.user_id);
}
