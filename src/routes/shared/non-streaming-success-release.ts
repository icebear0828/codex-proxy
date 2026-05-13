import type { AccountPool } from "../../auth/account-pool.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";

export interface ReleaseNonStreamingSuccessAccountOptions {
  accountPool: AccountPool;
  entryId: string;
  usage: UsageInfo;
  expectsImageGen?: boolean;
  released: Set<string>;
}

export function releaseNonStreamingSuccessAccount(options: ReleaseNonStreamingSuccessAccountOptions): void {
  const {
    accountPool,
    entryId,
    usage,
    expectsImageGen,
    released,
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(usage, expectsImageGen), released);
}
