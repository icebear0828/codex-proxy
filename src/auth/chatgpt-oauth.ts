import {
  decodeJwtPayload,
  extractChatGptAccountId,
  isTokenExpired,
} from "./jwt-utils.js";

/**
 * Validate a manually-pasted JWT token.
 */
export function validateManualToken(token: string): {
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

  if (isTokenExpired(trimmed)) {
    return { valid: false, error: "Token is expired" };
  }

  const accountId = extractChatGptAccountId(trimmed);
  if (!accountId) {
    return { valid: false, error: "Token missing chatgpt_account_id claim" };
  }

  return { valid: true };
}
