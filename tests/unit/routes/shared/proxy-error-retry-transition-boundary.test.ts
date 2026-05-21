import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as errorRetryTransition from "@src/routes/shared/proxy-error-retry-transition.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const ERROR_RETRY_TRANSITION_MODULE = "src/routes/shared/proxy-error-retry-transition.ts";

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

describe("proxy error retry transition boundary", () => {
  it("exports the error retry transition helper", () => {
    expect(errorRetryTransition.applyProxyErrorRetryTransition).toBeTypeOf("function");
  });

  it("keeps release/restore/fallback transition details out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-error-retry-transition.js",
      "applyProxyErrorRetryTransition",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(proxyHandler).not.toContain("decision.releaseBeforeRetry");
    expect(proxyHandler).not.toContain("decision.markModelRetried");
    expect(proxyHandler).not.toContain("prepareProxyFallbackAccountRetry({");
    expect(proxyHandler).not.toContain("fallbackRetry.action");
  });

  it("does not let the error retry transition helper own HTTP rendering or response handling", () => {
    const helper = source(ERROR_RETRY_TRANSITION_MODULE);

    expect(importedModuleSpecifiers(helper, ERROR_RETRY_TRANSITION_MODULE)).not.toEqual(expect.arrayContaining([
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./proxy-retry-recovery.js",
      "./proxy-stagger.js",
      "hono",
    ]));
  });
});
