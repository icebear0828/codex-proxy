import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as fallbackRetryPlan from "@src/routes/shared/proxy-fallback-retry-plan.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FALLBACK_RETRY_PLAN_MODULE = "src/routes/shared/proxy-fallback-retry-plan.ts";
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

function importedModuleSpecifiers(content: string, path = "inline.ts"): string[] {
  const file = parseSource(path, content);
  return file.statements
    .filter(ts.isImportDeclaration)
    .map(moduleSpecifierText)
    .filter((specifier): specifier is string => Boolean(specifier));
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

describe("proxy fallback retry plan module boundary", () => {
  it("exports the fallback retry planning helper from its own module", () => {
    expect(fallbackRetryPlan.buildProxyFallbackRetryPlan).toBeTypeOf("function");
  });

  it("keeps account exhaustion response planning out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-fallback-retry-plan.js",
      "buildProxyFallbackRetryPlan",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBindingFromAnyModule(
      proxyHandler,
      "buildAccountExhaustionDetail",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
  });

  it("keeps account switching side effects out of the fallback retry planner", () => {
    const fallbackRetryPlan = source(FALLBACK_RETRY_PLAN_MODULE);

    expect(importedModuleSpecifiers(fallbackRetryPlan, FALLBACK_RETRY_PLAN_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-handler-utils.js",
      "./proxy-stagger.js",
      "./proxy-handler.js",
      "hono",
    ]));
  });
});
