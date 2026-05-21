import type { AccountPool } from "../../auth/account-pool.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { acquireAccount } from "./account-acquisition.js";
import { buildProxyFallbackRetryPlan } from "./proxy-fallback-retry-plan.js";
import type { ErrorAction } from "./proxy-error-handler.js";
import { buildCodexApi } from "./proxy-handler-utils.js";

type RetryDecision = Extract<ErrorAction, { action: "retry" }>;

export type ProxyFallbackAccountRetryResult =
  | {
      action: "respond";
      status: number;
      message: string;
      useFormat429?: true;
    }
  | {
      action: "retry";
      entryId: string;
      api: CodexApi;
      prevSlotMs: number | null;
    };

export interface PrepareProxyFallbackAccountRetryOptions {
  accountPool: AccountPool;
  model: string;
  triedEntryIds: string[];
  tag: string;
  decision: RetryDecision;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  log?: (message: string) => void;
}

export function prepareProxyFallbackAccountRetry(
  options: PrepareProxyFallbackAccountRetryOptions,
): ProxyFallbackAccountRetryResult {
  const {
    accountPool,
    model,
    triedEntryIds,
    tag,
    decision,
    cookieJar,
    proxyPool,
    log = console.log,
  } = options;
  const excludeEntryIds = [...triedEntryIds];

  const fallbackAvailability = accountPool.hasAvailableAccounts(excludeEntryIds)
    ? { available: true } as const
    : { available: false, summary: accountPool.getPoolSummary() } as const;
  const fallbackPlan = buildProxyFallbackRetryPlan({
    decision,
    availability: fallbackAvailability,
  });

  if (fallbackPlan.action === "respond") {
    return fallbackPlan;
  }

  const retry = acquireAccount(accountPool, model, excludeEntryIds, tag);
  if (!retry) {
    return {
      action: "respond",
      status: decision.status,
      message: decision.message,
      ...(decision.useFormat429 ? { useFormat429: true } : {}),
    };
  }

  const api = buildCodexApi(retry.token, retry.accountId, cookieJar, retry.entryId, proxyPool);
  log(`[${tag}] Fallback \u2192 account ${retry.entryId}`);
  return {
    action: "retry",
    entryId: retry.entryId,
    api,
    prevSlotMs: retry.prevSlotMs,
  };
}
