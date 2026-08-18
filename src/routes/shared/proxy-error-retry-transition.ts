import type { AccountPool } from "../../auth/account-pool.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { releaseAccount } from "./account-acquisition.js";
import { prepareProxyFallbackAccountRetry } from "./proxy-fallback-account-retry.js";
import type { ErrorAction } from "./proxy-error-handler.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";

export type ProxyErrorRetryTransitionResult =
  | {
      action: "respond";
      status: number;
      message: string;
      useFormat429?: true;
      modelRetried: boolean;
    }
  | {
      action: "retry";
      entryId: string;
      api: CodexApi;
      prevSlotMs: number | null;
      modelRetried: boolean;
    };

export interface ApplyProxyErrorRetryTransitionOptions {
  accountPool: AccountPool;
  entryId: string;
  model: string;
  triedEntryIds: string[];
  tag: string;
  decision: ErrorAction;
  released: Set<string>;
  restoreImplicitResumeRequest: () => void;
  modelRetried: boolean;
  expectsImageGen?: boolean;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
}

export function applyProxyErrorRetryTransition(
  options: ApplyProxyErrorRetryTransitionOptions,
): ProxyErrorRetryTransitionResult {
  const {
    accountPool,
    entryId,
    model,
    triedEntryIds,
    tag,
    decision,
    released,
    restoreImplicitResumeRequest,
    modelRetried,
    expectsImageGen,
    cookieJar,
    proxyPool,
  } = options;

  if (decision.action === "respond") {
    releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, expectsImageGen), released);
    return {
      action: "respond",
      status: decision.status,
      message: decision.message,
      modelRetried,
    };
  }

  if (decision.releaseBeforeRetry) {
    releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, expectsImageGen), released);
  }
  restoreImplicitResumeRequest();
  const nextModelRetried = decision.markModelRetried ? true : modelRetried;

  const fallbackRetry = prepareProxyFallbackAccountRetry({
    accountPool,
    model,
    triedEntryIds,
    tag,
    decision,
    cookieJar,
    proxyPool,
  });

  if (fallbackRetry.action === "respond") {
    return {
      action: "respond",
      status: fallbackRetry.status,
      message: fallbackRetry.message,
      ...(fallbackRetry.useFormat429 ? { useFormat429: true } : {}),
      modelRetried: nextModelRetried,
    };
  }

  return {
    action: "retry",
    entryId: fallbackRetry.entryId,
    api: fallbackRetry.api,
    prevSlotMs: fallbackRetry.prevSlotMs,
    modelRetried: nextModelRetried,
  };
}
