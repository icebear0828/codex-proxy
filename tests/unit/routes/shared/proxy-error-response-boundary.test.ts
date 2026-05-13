import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildAccountExhaustionDetail,
  respondWithNoAccount,
  respondWithProxyError,
} from "@src/routes/shared/proxy-error-response.js";

const ROOT = process.cwd();
const ERROR_RESPONSE_MODULE = "src/routes/shared/proxy-error-response.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

function parseSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function moduleSpecifierText(node: ts.ImportDeclaration): string | null {
  const moduleSpecifier = node.moduleSpecifier;
  return moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) ? moduleSpecifier.text : null;
}

function importedModuleSpecifiers(content: string, path = "inline.ts"): string[] {
  const file = parseSource(path, content);
  return file.statements
    .filter(ts.isImportDeclaration)
    .map(moduleSpecifierText)
    .filter((specifier): specifier is string => Boolean(specifier));
}

function importsNamedBinding(content: string, moduleSuffix: string, bindingName: string, path = "inline.ts"): boolean {
  const file = parseSource(path, content);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = moduleSpecifierText(statement);
    if (!specifier?.endsWith(moduleSuffix)) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    if (namedBindings.elements.some((element) => {
      const importedName = element.propertyName?.text ?? element.name.text;
      return importedName === bindingName || element.name.text === bindingName;
    })) {
      return true;
    }
  }
  return false;
}

describe("proxy error response module boundary", () => {
  it("exports route error response helpers from their own module", () => {
    expect(respondWithNoAccount).toBeTypeOf("function");
    expect(respondWithProxyError).toBeTypeOf("function");
    expect(buildAccountExhaustionDetail).toBeTypeOf("function");

    const errorResponse = source(ERROR_RESPONSE_MODULE);
    expect(importsNamedBinding(errorResponse, "stream-error-response.js", "streamErrorResponse", ERROR_RESPONSE_MODULE)).toBe(true);
    expect(importsNamedBinding(errorResponse, "stream-error-response.js", "canReturnStreamError", ERROR_RESPONSE_MODULE)).toBe(true);
  });

  it("keeps stream-vs-json error rendering out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-error-response.js", "respondWithNoAccount", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-error-response.js", "respondWithProxyError", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-error-response.js", "buildAccountExhaustionDetail", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importedModuleSpecifiers(proxyHandler, PROXY_HANDLER_MODULE)).not.toEqual(expect.arrayContaining([
      "hono/utils/http-status",
      "./stream-error-response.js",
    ]));
  });
});
