import { createHash, randomUUID } from "crypto";
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

export function hashInstructions(instructions: string | null | undefined): string {
  return createHash("sha256").update(instructions ?? "").digest("hex");
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
  storedInstructionsHash: string | null;
  requiredFunctionCallOutputIds?: string[];
  storedFunctionCallIds?: string[];
  /** call_ids of `function_call` items inlined in the request input itself.
   *  When a function_call_output references a call_id present here, the
   *  client is doing a self-contained full-history replay and we should NOT
   *  treat the absence of that id in session-affinity as "missing tool calls". */
  inlineFunctionCallIds?: string[];
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
  if (hashInstructions(opts.currentInstructions) !== opts.storedInstructionsHash) {
    return { active: false, reason: "instr_diff" };
  }
  const storedFunctionCallIds = new Set(opts.storedFunctionCallIds ?? []);
  const inlineFunctionCallIds = new Set(opts.inlineFunctionCallIds ?? []);
  const requiredFunctionCallOutputIds = opts.requiredFunctionCallOutputIds ?? [];

  // Self-contained replay: every function_call_output in the input is paired
  // with a function_call also inlined in the input (typical of Codex CLI
  // /compact or error-recovery fallback). Implicit resume is not applicable —
  // upstream will satisfy the outputs from the inlined calls directly. Bail
  // before the missing_tool_calls check so we don't 413 a legitimate replay.
  if (
    requiredFunctionCallOutputIds.length > 0 &&
    requiredFunctionCallOutputIds.every((id) => inlineFunctionCallIds.has(id))
  ) {
    return { active: false, reason: "self_contained_replay" };
  }

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

/** Typed input items that are model output. The implicit-resume continuation
 *  delta starts after the LAST model-output item: everything that follows it
 *  (tool outputs, new user messages) is client-provided and must be re-sent
 *  alongside `previous_response_id`. This set must cover every tool-call item
 *  type a model can emit — gpt-5.6's unified exec emits `custom_tool_call`
 *  instead of `function_call`, and before it was listed here the anchor froze
 *  at the last assistant message: every resumed request re-sent an
 *  ever-growing input tail on top of a prev chain that already contained
 *  those items, ballooning server-side context until the window overflowed
 *  and the upstream fast-failed every retry. */
const MODEL_OUTPUT_ITEM_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

/** Client-provided tool result item types, paired with the call types above. */
const TOOL_CALL_OUTPUT_ITEM_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

export function getContinuationInputStartIndex(input: CodexResponsesRequest["input"]): number {
  let lastModelOutputIndex = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if ("role" in item) {
      if (item.role === "assistant") lastModelOutputIndex = i;
      continue;
    }
    if (MODEL_OUTPUT_ITEM_TYPES.has(item.type)) {
      lastModelOutputIndex = i;
    }
  }
  return lastModelOutputIndex >= 0 ? lastModelOutputIndex + 1 : 0;
}

export function getFunctionCallOutputIds(input: CodexResponsesRequest["input"]): string[] {
  const ids: string[] = [];
  for (const item of input) {
    if ("role" in item || !TOOL_CALL_OUTPUT_ITEM_TYPES.has(item.type)) continue;
    const callId = (item as { call_id?: unknown }).call_id;
    if (typeof callId === "string" && callId) ids.push(callId);
  }
  return ids;
}

/** Collect call_ids of tool-call items (`function_call` / `custom_tool_call`)
 *  inlined in the request input. Codex CLI emits these when doing a
 *  client-side full-history replay (e.g. after /compact or error recovery):
 *  the input carries the historical call entries paired with their output
 *  entries, so the proxy must not try to validate those outputs against
 *  session-affinity's stored ids — they reference calls that live in the
 *  input itself, not in any prior upstream response we tracked. */
export function getInlineFunctionCallIds(input: CodexResponsesRequest["input"]): string[] {
  const ids: string[] = [];
  for (const item of input) {
    if ("role" in item || !MODEL_OUTPUT_ITEM_TYPES.has(item.type)) continue;
    const callId = (item as { call_id?: unknown }).call_id;
    if (typeof callId === "string" && callId) ids.push(callId);
  }
  return ids;
}

/** True when every function_call_output in the input is paired with a
 *  function_call also inlined in the input (i.e. the client is sending a
 *  self-contained full-history replay, not an incremental continuation). */
export function isSelfContainedReplay(input: CodexResponsesRequest["input"]): boolean {
  const outputs = getFunctionCallOutputIds(input);
  if (outputs.length === 0) return false;
  const inlineCalls = new Set(getInlineFunctionCallIds(input));
  return outputs.every((id) => inlineCalls.has(id));
}
