/**
 * Conversation-scoped quarantine for safety-policy rejections.
 *
 * Why the conversation and not the account: the upstream verdict is a function
 * of the *content* (see `policy-rejection.ts`), so every account in the pool
 * would earn the same rejection — rotating accounts spreads one violation
 * across many credentials instead of containing it. The account is not at
 * fault, so this tracker never touches account status.
 *
 * Why the conversation and not the request: the offending span stays in the
 * conversation. Every later turn resends it (full-history clients) or leaves it
 * in the upstream response chain (`previous_response_id` clients), and clients
 * in autonomous "goal" modes generate those turns without a human in the loop.
 * A per-request guard would only stop the retry in front of it.
 *
 * The key is the conversation identity the proxy derives itself — invariant
 * under its own retry transformations (`strip_and_retry` drops
 * `previous_response_id`, rotation changes the account), so the guard cannot be
 * bypassed by the proxy's own recovery paths. Keying on the identity upstream
 * sees would let our own retries look like a brand-new conversation.
 *
 * Release is content-aware rather than purely time-based. A wall-clock TTL
 * alone would keep a conversation blocked after the user edited the offending
 * content — they would have done the right thing and still be refused, with no
 * way out short of restarting the process. So the entry also records the
 * sequence of input-item digests seen at rejection time, and the guard blocks
 * only while that sequence is still a prefix of the current input. Edit or
 * remove the offending history and the prefix diverges, which releases the
 * conversation automatically. `resetConversationQuarantine` is the manual
 * escape hatch; TTL bounds both the memory and a false positive.
 */

import { createHash } from "crypto";
import { getConfig } from "../config.js";

export const DEFAULT_QUARANTINE_TTL_SECONDS = 3600;

interface QuarantineEntry {
  recordedAt: number;
  /** Input-item digests present when the rejection was observed. */
  inputPrefix: string[];
  code: string;
  message: string;
}

const entries = new Map<string, QuarantineEntry>();

/** Canonical JSON so a key-order change cannot masquerade as edited history. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** Digest each input item so the guard can compare conversation prefixes. */
export function hashInputItems(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) =>
    createHash("sha256").update(stableStringify(item)).digest("hex").slice(0, 16),
  );
}

function ttlMs(): number {
  try {
    const seconds = getConfig().policy_guard.ttl_seconds;
    return seconds > 0 ? seconds * 1000 : DEFAULT_QUARANTINE_TTL_SECONDS * 1000;
  } catch {
    return DEFAULT_QUARANTINE_TTL_SECONDS * 1000;
  }
}

function isPrefixOf(stored: readonly string[], current: readonly string[]): boolean {
  if (stored.length > current.length) return false;
  for (let i = 0; i < stored.length; i += 1) {
    if (stored[i] !== current[i]) return false;
  }
  return true;
}

export interface RecordQuarantineOptions {
  conversationId: string;
  /** The conversation input as sent on the rejected request. */
  input: unknown;
  code?: string;
  message: string;
  now?: number;
}

/**
 * Remember that `conversationId` was rejected. Recording is idempotent in the
 * sense that the newest observation wins: a later rejection re-anchors the
 * prefix, so a conversation that was edited and rejected again is guarded from
 * the new content onwards.
 */
export function recordConversationQuarantine(options: RecordQuarantineOptions): void {
  const { conversationId, input, code, message } = options;
  if (!conversationId) return;
  entries.set(conversationId, {
    recordedAt: options.now ?? Date.now(),
    inputPrefix: hashInputItems(input),
    code: code ?? "unknown",
    message,
  });
}

export interface PeekQuarantineOptions {
  conversationId: string;
  /** The conversation input about to be sent. */
  input: unknown;
  now?: number;
}

export interface QuarantineVerdict {
  blocked: boolean;
  code?: string;
  message?: string;
}

/**
 * Decide whether this request must be refused locally. Blocks while the
 * recorded input prefix is still intact; an edited (divergent) history or an
 * expired entry releases the conversation.
 */
export function peekConversationQuarantine(options: PeekQuarantineOptions): QuarantineVerdict {
  const { conversationId, input } = options;
  const entry = conversationId ? entries.get(conversationId) : undefined;
  if (!entry) return { blocked: false };

  const now = options.now ?? Date.now();
  if (now - entry.recordedAt > ttlMs()) {
    entries.delete(conversationId);
    return { blocked: false };
  }

  if (!isPrefixOf(entry.inputPrefix, hashInputItems(input))) {
    // History diverged — the user edited or removed the offending content, or
    // the conversation moved on in a way that no longer replays it.
    entries.delete(conversationId);
    return { blocked: false };
  }

  return { blocked: true, code: entry.code, message: entry.message };
}

/** Manual release (dashboard / admin escape hatch). */
export function resetConversationQuarantine(conversationId: string): void {
  entries.delete(conversationId);
}

/** Snapshot for diagnostics. */
export function listConversationQuarantines(
  now: number = Date.now(),
): Array<{ conversationId: string; recordedAt: number; code: string; message: string }> {
  const ttl = ttlMs();
  const out: Array<{ conversationId: string; recordedAt: number; code: string; message: string }> = [];
  for (const [conversationId, entry] of entries) {
    if (now - entry.recordedAt > ttl) continue;
    out.push({ conversationId, recordedAt: entry.recordedAt, code: entry.code, message: entry.message });
  }
  return out;
}

/** Visible for tests. */
export function _resetAllConversationQuarantines(): void {
  entries.clear();
}
