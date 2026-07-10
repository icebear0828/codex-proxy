import type { ResponseMetadata } from "./proxy-handler-types.js";
import type { ReasoningReplayItem } from "../../proxy/reasoning-replay-cache.js";

export interface ResponseMetadataCollector {
  responseFunctionCallIds: Set<string>;
  reasoningReplayItems: ReasoningReplayItem[];
  invalidReasoningReplay: boolean;
  prematureClose: boolean;
  terminalFailure: boolean;
  onResponseMetadata: (metadata: ResponseMetadata) => void;
}

export function createResponseMetadataCollector(): ResponseMetadataCollector {
  const responseFunctionCallIds = new Set<string>();
  const reasoningReplayItems: ReasoningReplayItem[] = [];
  const collector: ResponseMetadataCollector = {
    responseFunctionCallIds,
    reasoningReplayItems,
    invalidReasoningReplay: false,
    prematureClose: false,
    terminalFailure: false,
    onResponseMetadata: (metadata) => {
      for (const callId of metadata.functionCallIds ?? []) {
        responseFunctionCallIds.add(callId);
      }
      reasoningReplayItems.push(...(metadata.reasoningReplayItems ?? []));
      if (metadata.invalidReasoningReplay) {
        collector.invalidReasoningReplay = true;
      }
      if (metadata.prematureClose) {
        collector.prematureClose = true;
      }
      if (metadata.terminalFailure) {
        collector.terminalFailure = true;
      }
    },
  };
  return collector;
}
