/**
 * Detects upstream safety-policy rejections that must never be retried.
 *
 * Some deployments front the Codex backend with a content-safety gate: the
 * relay reuses OpenAI's own `cyber_policy` verdict and rejects the whole
 * *conversation*, not just the offending request. Two properties of that
 * verdict drive everything here:
 *
 *   1. It is a function of the content. Resending the same conversation — on
 *      the same account, on another account, or after stripping
 *      `previous_response_id` — reproduces the same rejection, so a retry
 *      cannot succeed; it only adds another violation report.
 *   2. Repeated reports escalate. The relay counts the reports that reached
 *      upstream and can ban the account on accumulation, while its own local
 *      session block (which never reaches upstream) does not count.
 *
 * The only useful response is therefore to stop sending and let the client
 * surface the error. `conversation-quarantine.ts` holds the conversation-scoped
 * memory of that decision.
 *
 * Matching order is deliberate. The structured `error.code` is the first-hand
 * signal — `cyber_policy` is an OpenAI API enum, `session_blocked_by_cyber_policy`
 * a hard-coded constant in the relay — whereas the human-readable sentence is a
 * second-hand translation an intermediate layer may rewrite or drop. Codes are
 * matched first; text is the fallback for deployments that strip them.
 *
 * Text is matched against upstream *error output* only, never against request
 * content: this proxy's traffic legitimately discusses security topics, so
 * scanning what the user sends would reject valid work.
 */

import { createHash } from "crypto";
import { getConfig } from "../config.js";

/** Codes that identify a safety-policy rejection. `cyber_policy` is OpenAI's;
 *  `session_blocked_by_cyber_policy` is emitted by a relay's own session gate. */
export const DEFAULT_POLICY_ERROR_CODES: readonly string[] = [
  "cyber_policy",
  "session_blocked_by_cyber_policy",
];

/** Text fallbacks, lowercase, matched as substrings of the error output. */
export const DEFAULT_POLICY_MESSAGE_PATTERNS: readonly string[] = [
  // OpenAI's own wording for a `cyber_policy` rejection.
  "possible cybersecurity risk",
  "high-risk cyber activity",
  // Bilingual template a sub2api-based relay substitutes for the above.
  "cyber-security policy",
  "网络安全策略屏蔽",
];

/**
 * Optional status-code allowlist. Empty (the default) means "no restriction",
 * so code/text matching decides on its own.
 *
 * This is a *narrowing* filter, not a trigger. A status alone must never mean
 * "policy rejection": 403 also means account ban and 429 also means rate limit,
 * so a status-triggered block would suppress those paths for every request
 * carrying that code. What the filter buys is the opposite direction — pinning
 * the guard to the statuses your relay actually uses for policy blocks, so an
 * unrelated 500 whose body happens to contain one of the patterns cannot trip
 * it.
 */
export const DEFAULT_POLICY_STATUS_CODES: readonly number[] = [];

export interface PolicyRejectionOptions {
  errorCodes?: readonly string[];
  messagePatterns?: readonly string[];
  statusCodes?: readonly number[];
}

interface ErrorLike {
  status?: unknown;
  body?: unknown;
  message?: unknown;
  code?: unknown;
}

/** Lowercase and collapse whitespace so patterns survive formatting drift. */
export function normalizePolicyText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Pull a structured error code out of an upstream error body. Handles the
 * shapes this proxy sees: `{error:{code}}` (HTTP), `{response:{error:{code}}}`
 * and a bare `{code}` (stream frames).
 */
export function extractPolicyErrorCode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return findCode(parsed);
}

function findCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "type", "error_code"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "response", "detail"] as const) {
    const nested = findCode(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Pure predicate. `errorCodes` / `messagePatterns` default to the built-in
 * lists; callers that already read config should pass them explicitly.
 */
export function matchesPolicyRejection(
  err: unknown,
  options: PolicyRejectionOptions = {},
): boolean {
  if (!err || typeof err !== "object") return false;
  const { body, message, code, status } = err as ErrorLike;

  const codes = options.errorCodes ?? DEFAULT_POLICY_ERROR_CODES;
  const patterns = options.messagePatterns ?? DEFAULT_POLICY_MESSAGE_PATTERNS;
  const statuses = options.statusCodes ?? DEFAULT_POLICY_STATUS_CODES;

  // Status is an optional narrowing filter, never a trigger. It only applies
  // when a status is actually present: a stream terminal frame carries no HTTP
  // status, and skipping the filter there is better than guessing one.
  if (statuses.length > 0 && typeof status === "number" && !statuses.includes(status)) {
    return false;
  }

  const wanted = new Set(codes.map((c) => normalizePolicyText(c)));

  const directCode = typeof code === "string" ? code : undefined;
  const bodyText = typeof body === "string" ? body : "";
  const extractedCode = directCode ?? (bodyText ? extractPolicyErrorCode(bodyText) : undefined);
  if (extractedCode && wanted.has(normalizePolicyText(extractedCode))) return true;

  const haystack = normalizePolicyText(
    [bodyText, typeof message === "string" ? message : ""].join(" "),
  );
  if (!haystack) return false;
  if (patterns.some((p) => haystack.includes(normalizePolicyText(p)))) return true;
  // Some paths stringify the code into the message instead of exposing it as a
  // field (e.g. `throw new Error("Codex API error: <code>: <message>")`), so
  // also look for the codes inside the text.
  return codes.some((c) => haystack.includes(normalizePolicyText(c)));
}

/**
 * Config-gated entry point. Returns false when the guard is disabled or the
 * config is unavailable, so callers can treat a false as "behave as before".
 */
export function isPolicyRejection(err: unknown): boolean {
  const settings = readPolicyGuardSettings();
  if (!settings.enabled) return false;
  return matchesPolicyRejection(err, {
    errorCodes: settings.errorCodes,
    messagePatterns: settings.messagePatterns,
    statusCodes: settings.statusCodes,
  });
}

export interface PolicyGuardSettings {
  enabled: boolean;
  errorCodes: readonly string[];
  messagePatterns: readonly string[];
  statusCodes: readonly number[];
}

/** Read the guard config, falling back to "disabled" on any failure so a config
 *  problem can never silently change request-path behavior. */
export function readPolicyGuardSettings(): PolicyGuardSettings {
  try {
    const guard = getConfig().policy_guard;
    return {
      enabled: guard.enabled,
      errorCodes: guard.error_codes,
      messagePatterns: guard.message_patterns,
      statusCodes: guard.status_codes,
    };
  } catch {
    return {
      enabled: false,
      errorCodes: DEFAULT_POLICY_ERROR_CODES,
      messagePatterns: DEFAULT_POLICY_MESSAGE_PATTERNS,
      statusCodes: DEFAULT_POLICY_STATUS_CODES,
    };
  }
}

/**
 * Stable, log-safe signature for a rejection: status + code + a normalized
 * message digest. Never contains the raw message, which may quote the flagged
 * content.
 */
export function policyRejectionSignature(input: {
  status?: number | string;
  code?: string;
  message?: string;
}): string {
  const normalized = normalizePolicyText(input.message ?? "");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${input.status ?? "?"}:${input.code ?? "unknown"}:${digest}`;
}
