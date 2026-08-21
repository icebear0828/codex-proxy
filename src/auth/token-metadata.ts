import { decodeJwtPayload } from "./jwt-utils.js";

export type AccountIdSource = "access_token" | "id_token" | "upstream_discovery" | null;

export interface CodexTokenMetadata {
  accountId: string | null;
  organizationId: string | null;
  userId: string | null;
  email: string | null;
  planType: string | null;
  accountIdSource: AccountIdSource;
}

export interface CodexTokenMetadataHints {
  organizationId?: string | null;
  userId?: string | null;
  email?: string | null;
  planType?: string | null;
}

function recordClaim(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function organizationIdFromClaims(auth: Record<string, unknown>): string | null {
  const direct = nonEmptyString(
    auth.organization_id,
    auth.chatgpt_organization_id,
    auth.chatgpt_org_id,
    auth.poid,
  );
  if (direct) return direct;

  const organizations = Array.isArray(auth.organizations) ? auth.organizations : [];
  const records = organizations.map(recordClaim);
  const defaultOrg = records.find((org) => org.is_default === true);
  return nonEmptyString(defaultOrg?.id, ...records.map((org) => org.id));
}

/**
 * Extract portable Codex identity metadata from both OAuth tokens.
 *
 * Important trust boundary:
 * - accountId only comes from token claims here. File-level account-id hints are
 *   intentionally excluded because they eventually control ChatGPT-Account-Id.
 * - organizationId is kept separate and must never be sent as accountId.
 * - callers decide whether an unverified file-supplied id_token account ID must
 *   be confirmed by upstream discovery before use.
 */
export function extractCodexTokenMetadata(
  accessToken: string,
  idToken?: string | null,
  hints: CodexTokenMetadataHints = {},
): CodexTokenMetadata {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const accessAuth = recordClaim(accessPayload?.["https://api.openai.com/auth"]);
  const idAuth = recordClaim(idPayload?.["https://api.openai.com/auth"]);
  const accessProfile = recordClaim(accessPayload?.["https://api.openai.com/profile"]);
  const idProfile = recordClaim(idPayload?.["https://api.openai.com/profile"]);

  const accessAccountId = nonEmptyString(accessAuth.chatgpt_account_id);
  const idAccountId = nonEmptyString(idAuth.chatgpt_account_id);
  const accountId = accessAccountId ?? idAccountId;

  return {
    accountId,
    organizationId: nonEmptyString(
      organizationIdFromClaims(accessAuth),
      organizationIdFromClaims(idAuth),
      hints.organizationId,
    ),
    userId: nonEmptyString(
      accessAuth.chatgpt_user_id,
      accessAuth.user_id,
      accessProfile.chatgpt_user_id,
      accessProfile.user_id,
      idAuth.chatgpt_user_id,
      idAuth.user_id,
      idProfile.chatgpt_user_id,
      idProfile.user_id,
      hints.userId,
    ),
    email: nonEmptyString(
      accessProfile.email,
      accessPayload?.email,
      idProfile.email,
      idPayload?.email,
      hints.email,
    ),
    planType: nonEmptyString(
      accessAuth.chatgpt_plan_type,
      accessProfile.chatgpt_plan_type,
      idAuth.chatgpt_plan_type,
      idProfile.chatgpt_plan_type,
      hints.planType,
    ),
    accountIdSource: accessAccountId
      ? "access_token"
      : idAccountId
        ? "id_token"
        : null,
  };
}
