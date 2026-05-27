import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { computeVariantHash } from "./variant-hash.js";
import {
  buildVariantIdentity,
  getContinuationInputStartIndex,
  getFunctionCallOutputIds,
  getInlineFunctionCallIds,
  hashInstructions,
  IMPLICIT_RESUME_MAX_AGE_MS,
  resolvePromptCacheIdentity,
  type ImplicitResumeOpts,
} from "./proxy-session-helpers.js";

export type ProxyResumeEvaluationInput = Omit<ImplicitResumeOpts, "acquiredEntryId">;

export interface BuildProxySessionContextOptions {
  request: ProxyRequest;
  affinityMap: SessionAffinityMap;
}

export interface ProxySessionContext {
  currentInstructions: string | null | undefined;
  explicitPrevRespId: string | undefined;
  promptCacheKey: string;
  continuationInputStart: number;
  explicitConversationId: string | null;
  effectiveConversationId: string;
  chainConversationId: string;
  variantHash: string;
  implicitPrevRespId: string | null;
  prevRespId: string | null | undefined;
  implicitStoredInstructionsHash: string | null;
  implicitContinuationInput: ProxyRequest["codexRequest"]["input"];
  requiredFunctionCallOutputIds: string[];
  implicitStoredFunctionCallIds: string[];
  preferredEntryId: string | null;
  explicitTurnState: string | null;
  resumeEvaluationInput: ProxyResumeEvaluationInput;
}

export function buildProxySessionContext(
  options: BuildProxySessionContextOptions,
): ProxySessionContext {
  const { request, affinityMap } = options;
  const { codexRequest } = request;
  const currentInstructions = codexRequest.instructions;
  const explicitPrevRespId = codexRequest.previous_response_id;
  const promptCacheIdentity = resolvePromptCacheIdentity(codexRequest, request.clientConversationId);
  const promptCacheKey = promptCacheIdentity.promptCacheKey;
  const continuationInputStart = explicitPrevRespId ? 0 : getContinuationInputStartIndex(codexRequest.input);
  const explicitConversationId = explicitPrevRespId ? affinityMap.lookupConversationId(explicitPrevRespId) : null;
  const effectiveConversationId = promptCacheIdentity.conversationId;
  const chainConversationId = explicitConversationId ?? effectiveConversationId;
  const variantIdentity = buildVariantIdentity(codexRequest, promptCacheIdentity);
  const variantHash = computeVariantHash(codexRequest.instructions, codexRequest.tools, variantIdentity);
  const implicitPrevRespId =
    !explicitPrevRespId &&
    continuationInputStart > 0 &&
    effectiveConversationId
      ? affinityMap.lookupLatestResponseIdByConversationId(
          effectiveConversationId,
          IMPLICIT_RESUME_MAX_AGE_MS,
          variantHash,
        )
      : null;
  const prevRespId = explicitPrevRespId ?? implicitPrevRespId;
  const implicitStoredInstructionsHash = implicitPrevRespId
    ? affinityMap.lookupInstructionsHash(implicitPrevRespId)
    : null;
  const implicitContinuationInput = codexRequest.input.slice(continuationInputStart);
  const requiredFunctionCallOutputIds = implicitPrevRespId
    ? getFunctionCallOutputIds(implicitContinuationInput)
    : [];
  const implicitStoredFunctionCallIds = implicitPrevRespId
    ? affinityMap.lookupFunctionCallIds(implicitPrevRespId)
    : [];
  // Function_call entries inlined in the full request input — used by
  // evaluateImplicitResume to detect self-contained replays where matching
  // pairs already exist in the payload and resume is not applicable.
  const inlineFunctionCallIds = implicitPrevRespId
    ? getInlineFunctionCallIds(codexRequest.input)
    : [];
  const preferredEntryId =
    explicitPrevRespId
      ? affinityMap.lookup(explicitPrevRespId)
      : implicitPrevRespId && hashInstructions(currentInstructions) === implicitStoredInstructionsHash
        ? affinityMap.lookup(implicitPrevRespId)
        : null;
  const explicitTurnState = explicitPrevRespId ? affinityMap.lookupTurnState(explicitPrevRespId) : null;

  return {
    currentInstructions,
    explicitPrevRespId,
    promptCacheKey,
    continuationInputStart,
    explicitConversationId,
    effectiveConversationId,
    chainConversationId,
    variantHash,
    implicitPrevRespId,
    prevRespId,
    implicitStoredInstructionsHash,
    implicitContinuationInput,
    requiredFunctionCallOutputIds,
    implicitStoredFunctionCallIds,
    preferredEntryId,
    explicitTurnState,
    resumeEvaluationInput: {
      implicitPrevRespId,
      continuationInputStart,
      inputLength: codexRequest.input.length,
      preferredEntryId,
      currentInstructions,
      storedInstructionsHash: implicitStoredInstructionsHash,
      requiredFunctionCallOutputIds,
      storedFunctionCallIds: implicitStoredFunctionCallIds,
      inlineFunctionCallIds,
    },
  };
}
