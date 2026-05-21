import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as proxySessionContext from "@src/routes/shared/proxy-session-context.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SESSION_CONTEXT_MODULE = "src/routes/shared/proxy-session-context.ts";
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
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleSpecifierText(statement);
    if (!specifier?.endsWith(moduleSuffix)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
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

describe("proxy session context boundary", () => {
  it("exports the session context builder from its own module", () => {
    expect(proxySessionContext.buildProxySessionContext).toBeTypeOf("function");
  });

  it("keeps prompt-cache, affinity, and variant derivation out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-session-context.js",
      "buildProxySessionContext",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(proxyHandler, "variant-hash.js", "computeVariantHash", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "proxy-session-helpers.js", "resolvePromptCacheIdentity", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "proxy-session-helpers.js", "buildVariantIdentity", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "proxy-session-helpers.js", "getContinuationInputStartIndex", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "proxy-session-helpers.js", "getFunctionCallOutputIds", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "proxy-session-helpers.js", "IMPLICIT_RESUME_MAX_AGE_MS", PROXY_HANDLER_MODULE)).toBe(false);
  });

  it("keeps request mutation, account acquisition, and response handling out of the session context helper", () => {
    const helper = source(SESSION_CONTEXT_MODULE);

    expect(importedModuleSpecifiers(helper, SESSION_CONTEXT_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-request-preparation.js",
      "./proxy-implicit-resume-request.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./proxy-upstream-attempt.js",
      "hono",
    ]));
  });
});
