/**
 * Responses API compact handler — non-streaming JSON proxy for /v1/responses/compact.
 */

import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../auth/account-pool.js";
import { clearCfChallengeCooldown } from "../auth/cf-challenge-cooldown.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import type { CodexCompactRequest } from "../proxy/codex-api.js";
import { sanitizeCodexInputItems } from "../proxy/reasoning-input-sanitizer.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { supportsCodexAuxiliaryJson } from "../proxy/upstream-adapter.js";
import { parseModelName, resolveModelId, isRequestableModel } from "../models/model-store.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";
import { handleCodexApiError } from "./shared/proxy-error-handler.js";
import { staggerIfNeeded } from "./shared/proxy-stagger.js";
import { withRetry } from "../utils/retry.js";
import { PASSTHROUGH_FORMAT } from "./responses-passthrough.js";
import { isRecord } from "../translation/shared-utils.js";
import { annotateUsageCost } from "./shared/proxy-handler-utils.js";
import { handleCodexAuxiliaryJson } from "./codex-auxiliary.js";
import {
  applyResponsesLiteContract,
  isResponsesLiteRequest,
  parseReasoningContext,
  RESPONSES_LITE_HEADER,
  responsesLiteBody,
} from "../proxy/responses-lite.js";
import { sanitizeClientMetadata } from "../proxy/openai-subagent.js";

// ── Helpers ───────────────────────────────────────────────────────

function formatResponsesError(status: number, msg: string): unknown {
  return {
    type: "error",
    error: {
      type: "server_error",
      code: "codex_api_error",
      message: msg,
    },
  };
}

function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}

// ── Compact handler ───────────────────────────────────────────────

export async function handleCompact(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  proxyPool: ProxyPool | undefined,
  body: Record<string, unknown>,
  upstreamRouter?: UpstreamRouter,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : "codex";
  const useResponsesLite = isResponsesLiteRequest(
    c.req.header(RESPONSES_LITE_HEADER),
    sanitizeClientMetadata(body.client_metadata),
  );
  const compactRouteMatch = upstreamRouter?.resolveMatch(rawModel);
  if (
    (compactRouteMatch?.kind === "api-key" || compactRouteMatch?.kind === "adapter")
    && supportsCodexAuxiliaryJson(compactRouteMatch.adapter)
  ) {
    const directModel = compactRouteMatch.resolvedModel ?? rawModel;
    return handleCodexAuxiliaryJson({
      c,
      upstream: compactRouteMatch.adapter,
      path: "responses/compact",
      body: responsesLiteBody(
        directModel === rawModel ? body : { ...body, model: directModel },
        useResponsesLite,
      ),
      model: directModel,
    });
  }

  if (
    compactRouteMatch?.kind !== "api-key"
    && compactRouteMatch?.kind !== "adapter"
    && !isRequestableModel(rawModel)
  ) {
    c.status(404);
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        message: `Model '${rawModel}' not found`,
        param: "model",
      },
    });
  }

  const parsed = parseModelName(rawModel);
  const modelId = resolveModelId(parsed.modelId);

  const compactRequest: CodexCompactRequest = {
    model: modelId,
    input: Array.isArray(body.input) ? sanitizeCodexInputItems(body.input) : [],
    instructions: typeof body.instructions === "string" ? body.instructions : "",
  };
  compactRequest.useResponsesLite = useResponsesLite;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    compactRequest.tools = body.tools;
  }
  const compactExpectsImageGen = Array.isArray(body.tools)
    && body.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");
  const compactImageFailedUsage: UsageInfo | undefined = compactExpectsImageGen
    ? { input_tokens: 0, output_tokens: 0, image_request_attempted: true, image_request_succeeded: false }
    : undefined;
  if (typeof body.parallel_tool_calls === "boolean") {
    compactRequest.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (isRecord(body.reasoning)) {
    const r: Record<string, string> = {};
    if (typeof body.reasoning.effort === "string") r.effort = body.reasoning.effort;
    if (typeof body.reasoning.summary === "string") r.summary = body.reasoning.summary;
    const context = parseReasoningContext(body.reasoning.context);
    if (context) r.context = context;
    if (Object.keys(r).length > 0) compactRequest.reasoning = r;
  }
  applyResponsesLiteContract(compactRequest);
  if (
    isRecord(body.text) &&
    isRecord(body.text.format) &&
    typeof body.text.format.type === "string"
  ) {
    compactRequest.text = {
      format: {
        type: body.text.format.type as "text" | "json_object" | "json_schema",
        ...(typeof body.text.format.name === "string" ? { name: body.text.format.name } : {}),
        ...(isRecord(body.text.format.schema) ? { schema: body.text.format.schema as Record<string, unknown> } : {}),
        ...(typeof body.text.format.strict === "boolean" ? { strict: body.text.format.strict } : {}),
      },
    };
  }

  if (compactRouteMatch?.kind === "api-key" || compactRouteMatch?.kind === "adapter") {
    const directModel = compactRouteMatch.resolvedModel ?? rawModel;
    const directReq = {
      codexRequest: {
        model: directModel,
        input: compactRequest.input,
        instructions: compactRequest.instructions,
        stream: true as const,
        store: false as const,
        ...(compactRequest.tools ? { tools: compactRequest.tools } : {}),
        ...(compactRequest.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: compactRequest.parallel_tool_calls }
          : {}),
        ...(compactRequest.reasoning ? { reasoning: compactRequest.reasoning } : {}),
        ...(compactRequest.useResponsesLite ? { useResponsesLite: true } : {}),
        ...(compactRequest.text ? { text: compactRequest.text } : {}),
      },
      model: directModel,
      isStreaming: false,
    };
    return handleDirectRequest({ c, upstream: compactRouteMatch.adapter, req: directReq, fmt: PASSTHROUGH_FORMAT });
  }

  const TAG = "Compact";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();

  const acquired = acquireAccount(accountPool, modelId, undefined, TAG);
  if (!acquired) {
    c.status(503);
    return c.json(formatResponsesError(503, "No available accounts. All accounts are expired or rate-limited."));
  }

  let entryId = acquired.entryId;
  triedEntryIds.push(entryId);
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);

  console.log(
    `[${TAG}] Account ${entryId} | model=${modelId} | input_items=${compactRequest.input.length}`,
  );

  await staggerIfNeeded(acquired.prevSlotMs);

  const MAX_COMPACT_RETRIES = 8;
  for (let attempt = 0; attempt < MAX_COMPACT_RETRIES; attempt++) {
    try {
      const result = await withRetry(
        () => codexApi.createCompactResponse(compactRequest, c.req.raw.signal),
        { tag: TAG },
      );

      clearCfChallengeCooldown(entryId);
      releaseAccount(accountPool, entryId, annotateUsageCost(modelId, compactImageFailedUsage), released);
      return c.json(result);
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, annotateUsageCost(modelId, compactImageFailedUsage), released);
        throw err;
      }

      const decision = handleCodexApiError(
        err, accountPool, entryId, modelId, TAG, false,
      );

      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, annotateUsageCost(modelId, compactImageFailedUsage), released);
        c.status(decision.status as StatusCode);
        return c.json(formatResponsesError(decision.status, decision.message));
      }

      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, annotateUsageCost(modelId, compactImageFailedUsage), released);
      }

      const retry = acquireAccount(accountPool, modelId, triedEntryIds, TAG);
      if (!retry) {
        const status = decision.status as StatusCode;
        c.status(status);
        if (decision.useFormat429) {
          return c.json({
            type: "error",
            error: {
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
              message: decision.message,
            },
          });
        }
        return c.json(formatResponsesError(status, decision.message));
      }

      entryId = retry.entryId;
      triedEntryIds.push(entryId);
      codexApi = buildCodexApi(retry.token, retry.accountId, cookieJar, entryId, proxyPool);
      console.log(`[${TAG}] Fallback → account ${retry.entryId}`);
      await staggerIfNeeded(retry.prevSlotMs);
      continue;
    }
  }

  releaseAccount(accountPool, entryId, annotateUsageCost(modelId, compactImageFailedUsage), released);
  c.status(502);
  return c.json(formatResponsesError(502, "Compact failed after maximum retry attempts"));
}
