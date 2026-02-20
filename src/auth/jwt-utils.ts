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
    const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;

    const email = typeof profile?.email === "string" ? profile.email : undefined;
    // chatgpt_plan_type lives in the /auth claim, not /profile
    const chatgpt_plan_type =
      (typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined) ??
      (typeof profile?.chatgpt_plan_type === "string" ? profile.chatgpt_plan_type : undefined);
    const chatgpt_user_id =
      (typeof auth?.chatgpt_user_id === "string" ? auth.chatgpt_user_id : undefined) ??
      (typeof profile?.chatgpt_user_id === "string" ? profile.chatgpt_user_id : undefined);

    if (email || chatgpt_plan_type || chatgpt_user_id) {
      return { email, chatgpt_user_id, chatgpt_plan_type };
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
