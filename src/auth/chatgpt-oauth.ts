import {
  decodeJwtPayload,
  extractChatGptAccountId,
  isTokenExpired,
} from "./jwt-utils.js";

/**
 * Validate the non-negotiable JWT structure shared by all import paths.
 * This deliberately does not require chatgpt_account_id: some legitimate
 * OpenAI access tokens omit that claim and need identity discovery instead.
 */
export function validateTokenStructure(token: string): {
  valid: boolean;
  error?: string;
} {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token is empty" };
  }

  const trimmed = token.trim();
  const payload = decodeJwtPayload(trimmed);
  if (!payload) {
    return {
      valid: false,
      error: "Invalid JWT format — could not decode payload",
    };
  }

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { valid: false, error: "Token missing or invalid exp claim" };
  }

  if (isTokenExpired(trimmed)) {
    return { valid: false, error: "Token is expired" };
  }

  return { valid: true };
}

/**
 * Validate a manually-pasted JWT token using the legacy strict contract.
 */
export function validateManualToken(token: string): {
  valid: boolean;
  error?: string;
} {
  const structure = validateTokenStructure(token);
  if (!structure.valid) return structure;

  const trimmed = token.trim();

  const accountId = extractChatGptAccountId(trimmed);
  if (!accountId) {
    return { valid: false, error: "Token missing chatgpt_account_id claim" };
  }

  return { valid: true };
}
