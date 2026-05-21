import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as proxyRequestPreparation from "@src/routes/shared/proxy-request-preparation.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PREPARATION_MODULE = "src/routes/shared/proxy-request-preparation.ts";
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

describe("proxy request preparation boundary", () => {
  it("exports request preparation helpers from their own module", () => {
    expect(proxyRequestPreparation.ensureProxyRequestInputArray).toBeTypeOf("function");
    expect(proxyRequestPreparation.applyProxyRequestForwardingDefaults).toBeTypeOf("function");
  });

  it("keeps request preparation field mutation out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-request-preparation.js",
      "ensureProxyRequestInputArray",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-request-preparation.js",
      "applyProxyRequestForwardingDefaults",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(proxyHandler).not.toContain("!Array.isArray(req.codexRequest.input)");
    expect(proxyHandler).not.toContain("req.codexRequest.prompt_cache_key = promptCacheKey");
    expect(proxyHandler).not.toContain("req.codexRequest.include = [\"reasoning.encrypted_content\"]");
  });

  it("keeps account lifecycle and upstream side effects out of request preparation", () => {
    const helper = source(PREPARATION_MODULE);

    expect(importedModuleSpecifiers(helper, PREPARATION_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-stagger.js",
      "./proxy-handler.js",
      "./proxy-handler-utils.js",
      "../../proxy/codex-api.js",
      "hono",
    ]));
  });
});
