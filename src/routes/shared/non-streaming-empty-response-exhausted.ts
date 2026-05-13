import type { AccountPool } from "../../auth/account-pool.js";
import { releaseAccount } from "./account-acquisition.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";

export interface NonStreamingEmptyResponseExhaustedResponsePlan {
  status: 502;
  message: string;
}

export interface HandleNonStreamingEmptyResponseExhaustedOptions {
  accountPool: AccountPool;
  entryId: string;
  req: ProxyRequest;
  tag: string;
  attempt: number;
  maxRetries: number;
  released: Set<string>;
  logWarn?: (message: string) => void;
}

export function handleNonStreamingEmptyResponseExhausted(
  options: HandleNonStreamingEmptyResponseExhaustedOptions,
): NonStreamingEmptyResponseExhaustedResponsePlan {
  const {
    accountPool,
    entryId,
    req,
    tag,
    attempt,
    maxRetries,
    released,
    logWarn = (message) => console.warn(message),
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
  const email = accountPool.getEntry(entryId)?.email ?? "?";
  logWarn(
    `[${tag}] Account ${entryId} (${email}) | Empty response (attempt ${attempt}/${maxRetries + 1}), all retries exhausted`,
  );
  accountPool.recordEmptyResponse(entryId);

  return {
    status: 502,
    message: "Codex returned empty responses across all available accounts",
  };
}
