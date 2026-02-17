/**
 * JWT decode utilities for Codex Desktop proxy.
 * No signature verification — just payload extraction.
 */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractChatGptAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  try {
    const auth = payload["https://api.openai.com/auth"];
    if (auth && typeof auth === "object" && auth !== null) {
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      return typeof accountId === "string" ? accountId : null;
    }
  } catch {
    // ignore
  }
  return null;
}

export function extractUserProfile(
  token: string,
): { email?: string; chatgpt_user_id?: string; chatgpt_plan_type?: string } | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  try {
    const profile = payload["https://api.openai.com/profile"];
    if (profile && typeof profile === "object" && profile !== null) {
      const p = profile as Record<string, unknown>;
      return {
        email: typeof p.email === "string" ? p.email : undefined,
        chatgpt_user_id: typeof p.chatgpt_user_id === "string" ? p.chatgpt_user_id : undefined,
        chatgpt_plan_type: typeof p.chatgpt_plan_type === "string" ? p.chatgpt_plan_type : undefined,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function isTokenExpired(token: string, marginSeconds = 0): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  const exp = payload.exp;
  if (typeof exp !== "number") return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= exp - marginSeconds;
}
