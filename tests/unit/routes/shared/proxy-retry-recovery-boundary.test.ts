import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as retryRecovery from "@src/routes/shared/proxy-retry-recovery.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
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

function importsNamedBindingFromAnyModule(content: string, bindingName: string, path = "inline.ts"): boolean {
  const file = parseSource(path, content);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
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

describe("proxy retry recovery helper boundary", () => {
  it("exports the retry recovery decision helper from its own module", () => {
    expect(retryRecovery.buildProxyRetryRecoveryDecision).toBeTypeOf("function");
  });

  it("keeps same-account retry classification out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-retry-recovery.js",
      "buildProxyRetryRecoveryDecision",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importedModuleSpecifiers(proxyHandler, PROXY_HANDLER_MODULE)).not.toEqual(expect.arrayContaining([
      "../../proxy/error-classification.js",
    ]));
    expect(importsNamedBindingFromAnyModule(
      proxyHandler,
      "isPreviousResponseNotFoundError",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBindingFromAnyModule(
      proxyHandler,
      "isUnansweredFunctionCallError",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-handler-utils.js",
      "stripCodexErrorPrefix",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBindingFromAnyModule(
      proxyHandler,
      "stripCodexErrorPrefix",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
  });
});
