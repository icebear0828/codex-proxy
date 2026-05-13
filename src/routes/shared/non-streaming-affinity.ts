import type { SessionAffinityMap } from "../../auth/session-affinity.js";

export interface RecordNonStreamingSuccessAffinityOptions {
  affinityMap?: SessionAffinityMap;
  responseId: string | null;
  entryId: string;
  conversationId?: string | null;
  turnState?: string;
  instructions?: string | null;
  inputTokens: number;
  responseFunctionCallIds: Iterable<string>;
  variantHash?: string;
}

export function recordNonStreamingSuccessAffinity(
  options: RecordNonStreamingSuccessAffinityOptions,
): boolean {
  const {
    affinityMap,
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions,
    inputTokens,
    responseFunctionCallIds,
    variantHash,
  } = options;

  if (!responseId || !affinityMap || !conversationId) return false;

  affinityMap.record(
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions ?? undefined,
    inputTokens,
    Array.from(new Set(responseFunctionCallIds)),
    variantHash,
  );
  return true;
}
