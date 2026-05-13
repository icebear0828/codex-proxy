import type { CodexApi } from "../../proxy/codex-api.js";
import type {
  FormatAdapter,
  FormatCollectTranslatorResult,
  ProxyRequest,
  UsageHint,
} from "./proxy-handler-types.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";

export interface CollectNonStreamingResponseOptions {
  fmt: FormatAdapter;
  api: CodexApi;
  rawResponse: Response;
  req: ProxyRequest;
  usageHint?: UsageHint;
}

export interface CollectNonStreamingResponseResult {
  result: FormatCollectTranslatorResult;
  responseFunctionCallIds: Set<string>;
}

export async function collectNonStreamingResponse(
  options: CollectNonStreamingResponseOptions,
): Promise<CollectNonStreamingResponseResult> {
  const {
    fmt,
    api,
    rawResponse,
    req,
    usageHint,
  } = options;
  const metadataCollector = createResponseMetadataCollector();
  const result = await fmt.collectTranslator({
    api,
    response: rawResponse,
    model: req.model,
    tupleSchema: req.tupleSchema,
    usageHint,
    onResponseMetadata: metadataCollector.onResponseMetadata,
  });

  return {
    result,
    responseFunctionCallIds: metadataCollector.responseFunctionCallIds,
  };
}
