import { describe, expect, it } from "vitest";
import { handleNonStreaming } from "@src/routes/shared/non-streaming-handler.js";
import { retryNonStreamingEmptyResponse } from "@src/routes/shared/non-streaming-empty-response-retry.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const ROOT = process.cwd();
const NON_STREAMING_HANDLER_MODULE = "src/routes/shared/non-streaming-handler.ts";
const EMPTY_RESPONSE_RETRY_MODULE = "src/routes/shared/non-streaming-empty-response-retry.ts";

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
});
