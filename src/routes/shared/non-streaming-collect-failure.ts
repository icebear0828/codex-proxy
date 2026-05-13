import type { AccountPool } from "../../auth/account-pool.js";
import { releaseAccount } from "./account-acquisition.js";
import { planNonStreamingCollectErrorResponse } from "./non-streaming-collect-error-response.js";
import type { NonStreamingCollectErrorResponsePlan } from "./non-streaming-collect-error-response.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";

export interface HandleNonStreamingCollectFailureOptions {
  accountPool: AccountPool;
  entryId: string;
  req: ProxyRequest;
  collectErr: unknown;
  released: Set<string>;
}

export function handleNonStreamingCollectFailure(
  options: HandleNonStreamingCollectFailureOptions,
): NonStreamingCollectErrorResponsePlan {
  const {
    accountPool,
    entryId,
    req,
    collectErr,
    released,
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
  return planNonStreamingCollectErrorResponse(collectErr);
}
