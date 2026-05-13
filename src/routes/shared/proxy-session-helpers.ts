import { randomUUID } from "crypto";
import {
  PreviousResponseWebSocketError,
  type CodexResponsesRequest,
} from "../../proxy/codex-api.js";
import { deriveStableConversationKey } from "./stable-conversation-key.js";

/** Upper bound on how stale an implicit-resume `previous_response_id` may be.
 *  Must stay in sync with `DEFAULT_POOL_CONFIG.maxAgeMs` (3_300_000 ms) in
 *  `src/proxy/ws-pool.ts`: once the pool rotates the underlying connection,
 *  the upstream LB rehashes to a new backend and any prev id from the old
 *  connection is guaranteed not_found. Beyond this window reusing the id just
 *  costs one failed round-trip plus a strip-and-retry. Anthropic clients
 *  (Claude Code) hit this often because the protocol gives us no explicit
 *  prev id to anchor on. */
export const IMPLICIT_RESUME_MAX_AGE_MS = 55 * 60 * 1000;

export function normalizeInstructions(instructions: string | null | undefined): string {
  return instructions ?? "";
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface PromptCacheIdentity {
  promptCacheKey: string;
  conversationId: string;
  explicitPromptCacheKey: string | null;
  clientConversationId: string | null;
  derivedConversationId: string | null;
}

export function resolvePromptCacheIdentity(
  codexRequest: CodexResponsesRequest,
  clientConversationId?: string,
  generateFallbackId: () => string = () => randomUUID(),
): PromptCacheIdentity {
  const explicitPromptCacheKey = nonEmptyString(codexRequest.prompt_cache_key);
  const normalizedClientConversationId = nonEmptyString(clientConversationId);
  const derivedConversationId = deriveStableConversationKey(codexRequest);
  const promptCacheKey =
    explicitPromptCacheKey ??
    normalizedClientConversationId ??
    derivedConversationId ??
    generateFallbackId();

  return {
    promptCacheKey,
    conversationId: promptCacheKey,
    explicitPromptCacheKey,
    clientConversationId: normalizedClientConversationId,
    derivedConversationId,
  };
}

export function buildVariantIdentity(
  codexRequest: CodexResponsesRequest,
  identity: PromptCacheIdentity,
): string | null {
  const parts: string[] = [];
  const windowId = nonEmptyString(codexRequest.codexWindowId);
  if (windowId) parts.push(`window:${windowId}`);
  if ((identity.explicitPromptCacheKey || identity.clientConversationId) && identity.derivedConversationId) {
    parts.push(`anchor:${identity.derivedConversationId}`);
  }
  return parts.length > 0 ? parts.join("\x00") : null;
}

export interface ImplicitResumeOpts {
  implicitPrevRespId: string | null;
  continuationInputStart: number;
  inputLength: number;
  preferredEntryId: string | null;
  acquiredEntryId: string;
  currentInstructions: string | null | undefined;
  storedInstructions: string | null;
  requiredFunctionCallOutputIds?: string[];
  storedFunctionCallIds?: string[];
}

/** Reason why implicit resume was rejected, or null if it would activate.
 *  Returns "no_implicit_prev" when there's no candidate at all (caller can
 *  treat this as "not applicable").
 *
 *  When rejected with `missing_tool_calls` or `unanswered_tool_calls`, also
 *  returns the offending call_ids so the caller can surface them in logs
 *  without recomputing the same set difference. */
export function evaluateImplicitResume(opts: ImplicitResumeOpts):
  | { active: true; reason: null }
  | { active: false; reason: string; missingCallIds?: string[]; unansweredCallIds?: string[] } {
  if (!opts.implicitPrevRespId) return { active: false, reason: "no_implicit_prev" };
  if (opts.continuationInputStart >= opts.inputLength) {
    return { active: false, reason: "cont_start_eq_len" };
  }
  if (!opts.preferredEntryId) return { active: false, reason: "no_pref_entry" };
  if (opts.acquiredEntryId !== opts.preferredEntryId) {
    return { active: false, reason: "acct_mismatch" };
  }
  if (normalizeInstructions(opts.currentInstructions) !== normalizeInstructions(opts.storedInstructions)) {
    return { active: false, reason: "instr_diff" };
  }
  const storedFunctionCallIds = new Set(opts.storedFunctionCallIds ?? []);
  const requiredFunctionCallOutputIds = opts.requiredFunctionCallOutputIds ?? [];
  const missingCallIds = requiredFunctionCallOutputIds.filter((id) => !storedFunctionCallIds.has(id));
  if (missingCallIds.length > 0) {
    return { active: false, reason: "missing_tool_calls", missingCallIds };
  }
  // Reverse check: every stored function_call must be answered in this continuation.
  // Otherwise upstream rejects with "No tool output found for function call call_X".
  const requiredSet = new Set(requiredFunctionCallOutputIds);
  const unansweredCallIds = [...storedFunctionCallIds].filter((id) => !requiredSet.has(id));
  if (unansweredCallIds.length > 0) {
    return { active: false, reason: "unanswered_tool_calls", unansweredCallIds };
  }
  return { active: true, reason: null };
}

export function shouldActivateImplicitResume(opts: ImplicitResumeOpts): boolean {
  return evaluateImplicitResume(opts).active;
}

export function shouldReplayFullInputAfterImplicitResumeError(
  err: unknown,
  implicitResumeActive: boolean,
): err is PreviousResponseWebSocketError {
  return implicitResumeActive && err instanceof PreviousResponseWebSocketError;
}

export function getContinuationInputStartIndex(input: CodexResponsesRequest["input"]): number {
  let lastModelOutputIndex = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if ("role" in item) {
      if (item.role === "assistant") lastModelOutputIndex = i;
      continue;
    }
    if (item.type === "function_call") {
      lastModelOutputIndex = i;
    }
  }
  return lastModelOutputIndex >= 0 ? lastModelOutputIndex + 1 : 0;
}

export function getFunctionCallOutputIds(input: CodexResponsesRequest["input"]): string[] {
  return input
    .filter((item): item is { type: "function_call_output"; call_id: string; output: string } =>
      !("role" in item) && item.type === "function_call_output")
    .map((item) => item.call_id);
}
