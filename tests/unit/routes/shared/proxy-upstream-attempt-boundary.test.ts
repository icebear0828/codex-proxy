import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as proxyUpstreamAttempt from "@src/routes/shared/proxy-upstream-attempt.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ATTEMPT_MODULE = "src/routes/shared/proxy-upstream-attempt.ts";
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

describe("proxy upstream attempt boundary", () => {
  it("exports the upstream attempt helper from its own module", () => {
    expect(proxyUpstreamAttempt.sendProxyUpstreamAttempt).toBeTypeOf("function");
  });

  it("keeps one upstream attempt's dump/retry/egress details out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-upstream-attempt.js",
      "sendProxyUpstreamAttempt",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(proxyHandler).not.toContain("codexApi.createResponse(req.codexRequest");
    expect(proxyHandler).not.toContain("recordProxyEgressLog({");
    expect(proxyHandler).not.toContain("applyRateLimitHeaders({ accountPool, entryId, headers: rawResponse.headers })");
  });

  it("keeps account lifecycle, fallback, and response handling out of the upstream attempt helper", () => {
    const helper = source(ATTEMPT_MODULE);

    expect(importedModuleSpecifiers(helper, ATTEMPT_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-error-handler.js",
      "./proxy-error-response.js",
      "./proxy-fallback-retry-plan.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./proxy-stagger.js",
      "hono",
    ]));
  });
});
