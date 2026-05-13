import type { ResponseMetadata } from "./proxy-handler-types.js";

export interface ResponseMetadataCollector {
  responseFunctionCallIds: Set<string>;
  onResponseMetadata: (metadata: ResponseMetadata) => void;
}

export function createResponseMetadataCollector(): ResponseMetadataCollector {
  const responseFunctionCallIds = new Set<string>();
  return {
    responseFunctionCallIds,
    onResponseMetadata: (metadata) => {
      for (const callId of metadata.functionCallIds ?? []) {
        responseFunctionCallIds.add(callId);
      }
    },
  };
}
