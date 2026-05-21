import type { ProxyRequest } from "./proxy-handler-types.js";

export interface ApplyProxyRequestForwardingDefaultsOptions {
  request: ProxyRequest;
  promptCacheKey: string;
  explicitTurnState: string | null;
}

export function ensureProxyRequestInputArray(request: ProxyRequest): void {
  if (!Array.isArray(request.codexRequest.input)) {
    request.codexRequest.input = [];
  }
}

export function applyProxyRequestForwardingDefaults(
  options: ApplyProxyRequestForwardingDefaultsOptions,
): void {
  const { request, promptCacheKey, explicitTurnState } = options;

  request.codexRequest.prompt_cache_key = promptCacheKey;

  if (explicitTurnState) {
    request.codexRequest.turnState = explicitTurnState;
  }

  if (request.codexRequest.reasoning && !request.codexRequest.include?.length) {
    request.codexRequest.include = ["reasoning.encrypted_content"];
  }
}
