import { describe, expect, it } from "vitest";
import { handleNonStreaming } from "@src/routes/shared/non-streaming-handler.js";
import { retryNonStreamingEmptyResponse } from "@src/routes/shared/non-streaming-empty-response-retry.js";
import { handleNonStreamingPrematureClose } from "@src/routes/shared/non-streaming-premature-close.js";
import { logNonStreamingUsage } from "@src/routes/shared/non-streaming-usage-log.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const ROOT = process.cwd();
const NON_STREAMING_HANDLER_MODULE = "src/routes/shared/non-streaming-handler.ts";
const EMPTY_RESPONSE_RETRY_MODULE = "src/routes/shared/non-streaming-empty-response-retry.ts";
const PREMATURE_CLOSE_MODULE = "src/routes/shared/non-streaming-premature-close.ts";
const USAGE_LOG_MODULE = "src/routes/shared/non-streaming-usage-log.ts";

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
});
