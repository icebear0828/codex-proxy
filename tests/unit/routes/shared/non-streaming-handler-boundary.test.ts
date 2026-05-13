import { describe, expect, it } from "vitest";
import { handleNonStreaming } from "@src/routes/shared/non-streaming-handler.js";
import { retryNonStreamingEmptyResponse } from "@src/routes/shared/non-streaming-empty-response-retry.js";
import { handleNonStreamingPrematureClose } from "@src/routes/shared/non-streaming-premature-close.js";
import { logNonStreamingUsage } from "@src/routes/shared/non-streaming-usage-log.js";
import { recordNonStreamingSuccessAffinity } from "@src/routes/shared/non-streaming-affinity.js";
import { planNonStreamingCollectErrorResponse } from "@src/routes/shared/non-streaming-collect-error-response.js";
import { handleNonStreamingEmptyResponseExhausted } from "@src/routes/shared/non-streaming-empty-response-exhausted.js";
import { handleNonStreamingCollectFailure } from "@src/routes/shared/non-streaming-collect-failure.js";
import { rethrowNonStreamingCodexApiErrorDuringCollect } from "@src/routes/shared/non-streaming-codex-api-error.js";
import { releaseNonStreamingSuccessAccount } from "@src/routes/shared/non-streaming-success-release.js";
import { createResponseMetadataCollector } from "@src/routes/shared/response-metadata-collector.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const ROOT = process.cwd();
const NON_STREAMING_HANDLER_MODULE = "src/routes/shared/non-streaming-handler.ts";
const EMPTY_RESPONSE_RETRY_MODULE = "src/routes/shared/non-streaming-empty-response-retry.ts";
const PREMATURE_CLOSE_MODULE = "src/routes/shared/non-streaming-premature-close.ts";
const USAGE_LOG_MODULE = "src/routes/shared/non-streaming-usage-log.ts";
const AFFINITY_MODULE = "src/routes/shared/non-streaming-affinity.ts";
const COLLECT_ERROR_RESPONSE_MODULE = "src/routes/shared/non-streaming-collect-error-response.ts";
const EMPTY_RESPONSE_EXHAUSTED_MODULE = "src/routes/shared/non-streaming-empty-response-exhausted.ts";
const COLLECT_FAILURE_MODULE = "src/routes/shared/non-streaming-collect-failure.ts";
const CODEX_API_ERROR_MODULE = "src/routes/shared/non-streaming-codex-api-error.ts";
const SUCCESS_RELEASE_MODULE = "src/routes/shared/non-streaming-success-release.ts";
const RESPONSE_METADATA_COLLECTOR_MODULE = "src/routes/shared/response-metadata-collector.ts";

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

function importedModuleSpecifiers(content: string, path = "inline.ts"): string[] {
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs: string[] = [];

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (ts.isStringLiteral(moduleSpecifier)) specs.push(moduleSpecifier.text);
  }

  return specs;
}

function importsNamedBinding(content: string, moduleSuffix: string, binding: string, path = "inline.ts"): boolean {
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier) || !moduleSpecifier.text.endsWith(moduleSuffix)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    if (namedBindings.elements.some((element) => (element.propertyName?.text ?? element.name.text) === binding)) {
      return true;
    }
  }

  return false;
}

describe("non-streaming handler module boundary", () => {
  it("exports the non-streaming collect handler from its own module", () => {
    expect(handleNonStreaming).toBeTypeOf("function");
  });

  it("exports the empty-response retry helper from its own module", () => {
    expect(retryNonStreamingEmptyResponse).toBeTypeOf("function");
  });

  it("exports the premature-close helper from its own module", () => {
    expect(handleNonStreamingPrematureClose).toBeTypeOf("function");
  });

  it("exports the usage log helper from its own module", () => {
    expect(logNonStreamingUsage).toBeTypeOf("function");
  });

  it("exports the non-streaming affinity helper from its own module", () => {
    expect(recordNonStreamingSuccessAffinity).toBeTypeOf("function");
  });

  it("exports the collect error response planner from its own module", () => {
    expect(planNonStreamingCollectErrorResponse).toBeTypeOf("function");
  });

  it("exports the exhausted empty-response helper from its own module", () => {
    expect(handleNonStreamingEmptyResponseExhausted).toBeTypeOf("function");
  });

  it("exports the collect failure helper from its own module", () => {
    expect(handleNonStreamingCollectFailure).toBeTypeOf("function");
  });

  it("exports the CodexApiError collect rethrow helper from its own module", () => {
    expect(rethrowNonStreamingCodexApiErrorDuringCollect).toBeTypeOf("function");
  });

  it("exports the success release helper from its own module", () => {
    expect(releaseNonStreamingSuccessAccount).toBeTypeOf("function");
  });

  it("exports the response metadata collector helper from its own module", () => {
    expect(createResponseMetadataCollector).toBeTypeOf("function");
  });

  it("keeps empty-response retry reacquire and upstream send details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-empty-response-retry.js",
      "retryNonStreamingEmptyResponse",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(handler, "account-acquisition.js", "acquireAccount", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(handler, "proxy-handler-utils.js", "buildCodexApi", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(handler, "proxy-egress-log.js", "recordProxyEgressLog", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(handler, "../../utils/retry.js", "withRetry", NON_STREAMING_HANDLER_MODULE)).toBe(false);
  });

  it("does not let the empty-response retry helper own HTTP rendering or collect lifecycle", () => {
    const helper = source(EMPTY_RESPONSE_RETRY_MODULE);

    expect(importedModuleSpecifiers(helper, EMPTY_RESPONSE_RETRY_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "../../logs/entry.js",
    ]));
  });

  it("keeps premature-close stream event and release details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);
    const helper = source(PREMATURE_CLOSE_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-premature-close.js",
      "handleNonStreamingPrematureClose",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      handler,
      "stream-close-event.js",
      "recordStreamCloseEvent",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(
      helper,
      "stream-close-event.js",
      "recordStreamCloseEvent",
      PREMATURE_CLOSE_MODULE,
    )).toBe(true);
    expect(handler).not.toContain("upstream premature close (hadReasoning=");
  });

  it("does not let the premature-close helper own HTTP rendering or retry handling", () => {
    const helper = source(PREMATURE_CLOSE_MODULE);

    expect(importedModuleSpecifiers(helper, PREMATURE_CLOSE_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "../../logs/entry.js",
    ]));
  });

  it("keeps non-streaming usage log formatting details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-usage-log.js",
      "logNonStreamingUsage",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(handler).not.toContain("High input token count");
    expect(handler).not.toContain("cached=");
    expect(handler).not.toContain("uncached=");
  });

  it("does not let the usage log helper own HTTP rendering, retry handling, or account lifecycle", () => {
    const helper = source(USAGE_LOG_MODULE);

    expect(importedModuleSpecifiers(helper, USAGE_LOG_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./account-acquisition.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "../../auth/session-affinity.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
  });

  it("keeps non-streaming affinity record details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-affinity.js",
      "recordNonStreamingSuccessAffinity",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(handler).not.toContain("affinityMap.record(");
  });

  it("does not let the affinity helper own HTTP rendering, retry handling, usage logging, or account lifecycle", () => {
    const helper = source(AFFINITY_MODULE);

    expect(importedModuleSpecifiers(helper, AFFINITY_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./account-acquisition.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-usage-log.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("releaseAccount");
    expect(helper).not.toContain("logNonStreamingUsage");
  });

  it("keeps generic collect error status parsing out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-collect-failure.js",
      "handleNonStreamingCollectFailure",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      handler,
      "non-streaming-collect-error-response.js",
      "planNonStreamingCollectErrorResponse",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(handler, "proxy-error-handler.js", "toErrorStatus", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(handler).not.toContain("HTTP/[\\\\d.]");
    expect(handler).not.toContain("Unknown error");
  });

  it("does not let the collect error response planner own HTTP rendering, retry handling, or account lifecycle", () => {
    const helper = source(COLLECT_ERROR_RESPONSE_MODULE);

    expect(importedModuleSpecifiers(helper, COLLECT_ERROR_RESPONSE_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./account-acquisition.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-usage-log.js",
      "./non-streaming-affinity.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("releaseAccount");
  });

  it("keeps exhausted empty-response logging and recording details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-empty-response-exhausted.js",
      "handleNonStreamingEmptyResponseExhausted",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(handler).not.toContain("all retries exhausted");
    expect(handler).not.toContain("recordEmptyResponse");
    expect(handler).not.toContain("Codex returned empty responses across all available accounts");
  });

  it("does not let the exhausted empty-response helper own HTTP rendering, retry handling, or upstream sends", () => {
    const helper = source(EMPTY_RESPONSE_EXHAUSTED_MODULE);

    expect(importedModuleSpecifiers(helper, EMPTY_RESPONSE_EXHAUSTED_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "../../proxy/codex-api.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-usage-log.js",
      "./non-streaming-affinity.js",
      "../../utils/retry.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("createResponse");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("c.status");
    expect(helper).not.toContain("acquireAccount");
  });

  it("keeps generic collect failure release details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(handler).not.toContain("annotateImageGenOutcome(undefined, req.expectsImageGen)");
  });

  it("does not let the collect failure helper own HTTP rendering, retry handling, or upstream sends", () => {
    const helper = source(COLLECT_FAILURE_MODULE);

    expect(importsNamedBinding(
      helper,
      "non-streaming-collect-error-response.js",
      "planNonStreamingCollectErrorResponse",
      COLLECT_FAILURE_MODULE,
    )).toBe(true);
    expect(importedModuleSpecifiers(helper, COLLECT_FAILURE_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "../../proxy/codex-api.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-empty-response-exhausted.js",
      "./non-streaming-usage-log.js",
      "./non-streaming-affinity.js",
      "../../utils/retry.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("createResponse");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("c.status");
    expect(helper).not.toContain("acquireAccount");
    expect(helper).not.toContain("HTTP/[\\\\d.]");
    expect(helper).not.toContain("Unknown error");
  });

  it("keeps CodexApiError collect log formatting out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-codex-api-error.js",
      "rethrowNonStreamingCodexApiErrorDuringCollect",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      handler,
      "proxy-handler-utils.js",
      "stripCodexErrorPrefix",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(false);
    expect(handler).not.toContain("during collect:");
  });

  it("does not let the CodexApiError collect helper own account lifecycle, retry handling, or HTTP rendering", () => {
    const helper = source(CODEX_API_ERROR_MODULE);

    expect(importsNamedBinding(
      helper,
      "proxy-handler-utils.js",
      "stripCodexErrorPrefix",
      CODEX_API_ERROR_MODULE,
    )).toBe(true);
    expect(importedModuleSpecifiers(helper, CODEX_API_ERROR_MODULE)).not.toEqual(expect.arrayContaining([
      "hono",
      "./account-acquisition.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-empty-response-exhausted.js",
      "./non-streaming-collect-failure.js",
      "./non-streaming-collect-error-response.js",
      "../../utils/retry.js",
      "../../logs/entry.js",
    ]));
    expect(helper).not.toContain("releaseAccount");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("c.status");
    expect(helper).not.toContain("acquireAccount");
  });

  it("keeps success release details out of the collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "non-streaming-success-release.js",
      "releaseNonStreamingSuccessAccount",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(handler, "account-acquisition.js", "releaseAccount", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(
      handler,
      "proxy-handler-utils.js",
      "annotateImageGenOutcome",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(false);
    expect(handler).not.toContain("releaseAccount(accountPool");
  });

  it("does not let the success release helper own HTTP rendering, retry handling, logging, or affinity", () => {
    const helper = source(SUCCESS_RELEASE_MODULE);
    const importedSpecifiers = importedModuleSpecifiers(helper, SUCCESS_RELEASE_MODULE);

    expect(importsNamedBinding(
      helper,
      "account-acquisition.js",
      "releaseAccount",
      SUCCESS_RELEASE_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      helper,
      "proxy-handler-utils.js",
      "annotateImageGenOutcome",
      SUCCESS_RELEASE_MODULE,
    )).toBe(true);
    for (const disallowedSpecifier of [
      "hono",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./non-streaming-empty-response-retry.js",
      "./non-streaming-premature-close.js",
      "./non-streaming-empty-response-exhausted.js",
      "./non-streaming-collect-failure.js",
      "./non-streaming-collect-error-response.js",
      "./non-streaming-codex-api-error.js",
      "./non-streaming-usage-log.js",
      "./non-streaming-affinity.js",
      "../../utils/retry.js",
      "../../logs/entry.js",
    ]) {
      expect(importedSpecifiers).not.toContain(disallowedSpecifier);
    }
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("createResponse");
    expect(helper).not.toContain("formatError");
    expect(helper).not.toContain("c.json");
    expect(helper).not.toContain("c.status");
    expect(helper).not.toContain("recordNonStreamingSuccessAffinity");
    expect(helper).not.toContain("logNonStreamingUsage");
  });

  it("keeps response metadata collection details out of the non-streaming collect handler", () => {
    const handler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      handler,
      "response-metadata-collector.js",
      "createResponseMetadataCollector",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(handler).not.toContain("new Set<string>()");
    expect(handler).not.toContain("metadata.functionCallIds");
  });

  it("does not let the response metadata collector helper own response handling or account lifecycle", () => {
    const helper = source(RESPONSE_METADATA_COLLECTOR_MODULE);

    for (const disallowedSpecifier of [
      "hono",
      "./account-acquisition.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./response-processor.js",
      "./non-streaming-affinity.js",
      "./non-streaming-usage-log.js",
      "../../logs/entry.js",
    ]) {
      expect(importedModuleSpecifiers(helper, RESPONSE_METADATA_COLLECTOR_MODULE)).not.toContain(disallowedSpecifier);
    }
    expect(helper).not.toContain("collectTranslator");
    expect(helper).not.toContain("streamResponse");
    expect(helper).not.toContain("releaseAccount");
    expect(helper).not.toContain("c.json");
  });
});
