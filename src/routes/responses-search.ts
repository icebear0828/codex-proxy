import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { randomUUID } from "crypto";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { CodexApiError } from "../proxy/codex-types.js";
import { isCfChallengeError } from "../proxy/error-classification.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";
import { buildCodexApi } from "./shared/proxy-handler-utils.js";
import { handleCodexApiError } from "./shared/proxy-error-handler.js";
import { staggerIfNeeded } from "./shared/proxy-stagger.js";
import {
  codexAuxiliaryRequestContext,
  codexAuxiliaryResponseHeaders,
} from "./codex-auxiliary.js";

function searchError(c: Context, status: number, message: string): Response {
  c.status((status >= 400 && status < 600 ? status : 502) as StatusCode);
  return c.json({
    error: {
      message,
      type: status >= 400 && status < 500 ? "invalid_request_error" : "server_error",
      code: "codex_search_error",
    },
  });
}

function rawErrorResponse(error: CodexApiError, fallbackStatus: number): Response {
  const status = error.status >= 400 && error.status < 600 ? error.status : fallbackStatus;
  const headers = codexAuxiliaryResponseHeaders(error.headers ?? new Headers());
  if (!headers.has("content-type")) {
    try {
      JSON.parse(error.body);
      headers.set("content-type", "application/json");
    } catch {
      headers.set("content-type", "text/plain; charset=utf-8");
    }
  }
  return new Response(error.body, { status, headers });
}

/**
 * Search has a different error contract from /codex/responses. In particular,
 * a normal Search 402/403/404 describes this request or this still-evolving
 * endpoint; it is not reliable evidence that the OAuth account is exhausted,
 * banned, or Cloudflare path-blocked. Keep those client errors local so the
 * shared account-health classifier cannot mutate the pool or clear cookies.
 *
 * A positively identified Cloudflare challenge remains safe to classify and
 * retry, as do 401 and 429 which have account-wide meaning.
 */
function isTerminalSearchClientError(error: CodexApiError): boolean {
  return error.status >= 400
    && error.status < 500
    && error.status !== 401
    && error.status !== 429
    && !isCfChallengeError(error);
}

export async function handleOAuthCodexSearch(options: {
  c: Context;
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  body: Record<string, unknown>;
  model: string;
}): Promise<Response> {
  const { c, accountPool, cookieJar, proxyPool, body, model } = options;
  const tag = "Search";
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  const startMs = Date.now();
  const triedEntryIds: string[] = [];
  const released = new Set<string>();
  let earlyServerErrorRetried = false;
  let acquired = acquireAccount(accountPool, model, undefined, tag);
  if (!acquired) {
    return searchError(c, 503, "No available accounts. All accounts are expired or rate-limited.");
  }

  let lastError: CodexApiError | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entryId = acquired.entryId;
    triedEntryIds.push(entryId);
    const api = buildCodexApi(
      acquired.token,
      acquired.accountId,
      cookieJar,
      entryId,
      proxyPool,
      acquired.codexFingerprintMode ?? "off",
    );
    await staggerIfNeeded(acquired.prevSlotMs);

    try {
      const response = await api.createSearchResponse(
        body,
        codexAuxiliaryRequestContext(c, body, false),
        c.req.raw.signal,
      );
      releaseAccount(accountPool, entryId, undefined, released);
      enqueueLogEntry({
        requestId,
        direction: "egress",
        method: "POST",
        path: "/v1/alpha/search",
        model,
        provider: "codex",
        account: accountPool.getEntry(entryId)?.label ?? accountPool.getEntry(entryId)?.email ?? entryId.slice(0, 8),
        status: response.status,
        latencyMs: Date.now() - startMs,
        stream: false,
        request: { model, endpoint: "alpha/search" },
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: codexAuxiliaryResponseHeaders(response.headers),
      });
    } catch (error) {
      if (!(error instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      lastError = error;

      if (isTerminalSearchClientError(error)) {
        releaseAccount(accountPool, entryId, undefined, released);
        enqueueLogEntry({
          requestId,
          direction: "egress",
          method: "POST",
          path: "/v1/alpha/search",
          model,
          provider: "codex",
          account: accountPool.getEntry(entryId)?.label ?? accountPool.getEntry(entryId)?.email ?? entryId.slice(0, 8),
          status: error.status,
          latencyMs: Date.now() - startMs,
          stream: false,
          error: error.message,
          request: { model, endpoint: "alpha/search" },
        });
        return rawErrorResponse(error, error.status);
      }

      const decision = handleCodexApiError(
        error,
        accountPool,
        entryId,
        model,
        tag,
        false,
        cookieJar,
        earlyServerErrorRetried,
      );
      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, undefined, released);
        enqueueLogEntry({
          requestId,
          direction: "egress",
          method: "POST",
          path: "/v1/alpha/search",
          model,
          provider: "codex",
          account: accountPool.getEntry(entryId)?.label ?? accountPool.getEntry(entryId)?.email ?? entryId.slice(0, 8),
          status: decision.status,
          latencyMs: Date.now() - startMs,
          stream: false,
          error: error.message,
          request: { model, endpoint: "alpha/search" },
        });
        return rawErrorResponse(error, decision.status);
      }
      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, undefined, released);
      }
      if (decision.markEarlyServerErrorRetried) {
        earlyServerErrorRetried = true;
      }
      if (attempt === 7) {
        return rawErrorResponse(error, decision.status);
      }
      const next = acquireAccount(accountPool, model, triedEntryIds, tag);
      if (!next) {
        return rawErrorResponse(error, decision.status);
      }
      acquired = next;
    }
  }

  return lastError
    ? rawErrorResponse(lastError, 502)
    : searchError(c, 502, "Search failed after maximum retry attempts");
}
