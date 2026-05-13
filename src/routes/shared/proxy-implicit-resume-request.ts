import type { ProxyRequest, UsageHint } from "./proxy-handler-types.js";

export interface ImplicitResumeAffinityLookup {
  lookupTurnState(responseId: string): string | null;
  lookupInputTokens(responseId: string): number | null;
}

export interface ImplicitResumeRequestSnapshot {
  input: ProxyRequest["codexRequest"]["input"];
  previousResponseId: ProxyRequest["codexRequest"]["previous_response_id"];
  turnState: ProxyRequest["codexRequest"]["turnState"];
  useWebSocket: ProxyRequest["codexRequest"]["useWebSocket"];
  instructions: ProxyRequest["codexRequest"]["instructions"];
}

export interface ApplyImplicitResumeRequestOptions {
  request: ProxyRequest;
  implicitPrevRespId: string;
  continuationInputStart: number;
  affinityMap: ImplicitResumeAffinityLookup;
}

export interface RestoreImplicitResumeRequestStateOptions {
  request: ProxyRequest;
  snapshot: ImplicitResumeRequestSnapshot;
}

export function captureImplicitResumeRequestState(
  request: ProxyRequest,
): ImplicitResumeRequestSnapshot {
  return {
    input: request.codexRequest.input,
    previousResponseId: request.codexRequest.previous_response_id,
    turnState: request.codexRequest.turnState,
    useWebSocket: request.codexRequest.useWebSocket,
    instructions: request.codexRequest.instructions,
  };
}

export function applyImplicitResumeRequest(
  options: ApplyImplicitResumeRequestOptions,
): UsageHint {
  const { request, implicitPrevRespId, continuationInputStart, affinityMap } = options;

  request.codexRequest.previous_response_id = implicitPrevRespId;
  request.codexRequest.useWebSocket = true;
  request.codexRequest.input = request.codexRequest.input.slice(continuationInputStart);
  const implicitTurnState = affinityMap.lookupTurnState(implicitPrevRespId);
  if (implicitTurnState) request.codexRequest.turnState = implicitTurnState;

  return {
    reusedInputTokensUpperBound: affinityMap.lookupInputTokens(implicitPrevRespId) ?? undefined,
  };
}

export function restoreImplicitResumeRequestState(
  options: RestoreImplicitResumeRequestStateOptions,
): void {
  const { request, snapshot } = options;

  request.codexRequest.previous_response_id = snapshot.previousResponseId;
  request.codexRequest.turnState = snapshot.turnState;
  request.codexRequest.useWebSocket = snapshot.useWebSocket;
  request.codexRequest.input = snapshot.input;
  request.codexRequest.instructions = snapshot.instructions;
}
