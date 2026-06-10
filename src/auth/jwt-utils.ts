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

export interface CodexTokenMetadata {
  accountId: string | null;
  userId: string | null;
  email: string | null;
  planType: string | null;
}

function getAuthClaims(payload: Record<string, unknown> | null): Record<string, unknown> {
  const auth = payload?.["https://api.openai.com/auth"];
  return auth && typeof auth === "object" && auth !== null
    ? auth as Record<string, unknown>
    : {};
}

function getProfileClaims(payload: Record<string, unknown> | null): Record<string, unknown> {
  const profile = payload?.["https://api.openai.com/profile"];
  return profile && typeof profile === "object" && profile !== null
    ? profile as Record<string, unknown>
    : {};
}

function stringClaim(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function extractCodexTokenMetadata(
  accessToken: string,
  idToken?: string | null,
): CodexTokenMetadata {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const accessAuth = getAuthClaims(accessPayload);
  const idAuth = getAuthClaims(idPayload);
  const accessProfile = getProfileClaims(accessPayload);
  const idProfile = getProfileClaims(idPayload);

  return {
    accountId: stringClaim(
      accessAuth.chatgpt_account_id,
      idAuth.chatgpt_account_id,
    ),
    userId: stringClaim(
      accessAuth.chatgpt_user_id,
      accessProfile.chatgpt_user_id,
      idAuth.chatgpt_user_id,
      idProfile.chatgpt_user_id,
    ),
    email: stringClaim(
      accessProfile.email,
      idProfile.email,
      idPayload?.email,
    ),
    planType: stringClaim(
      accessAuth.chatgpt_plan_type,
      accessProfile.chatgpt_plan_type,
      idAuth.chatgpt_plan_type,
      idProfile.chatgpt_plan_type,
    ),
  };
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
