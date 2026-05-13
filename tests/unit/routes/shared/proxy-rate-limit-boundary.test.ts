import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { applyParsedRateLimits, applyRateLimitHeaders } from "@src/routes/shared/proxy-rate-limit.js";

const ROOT = process.cwd();
const RATE_LIMIT_MODULE = "src/routes/shared/proxy-rate-limit.ts";
const UPSTREAM_ATTEMPT_MODULE = "src/routes/shared/proxy-upstream-attempt.ts";
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

describe("proxy rate-limit helper boundary", () => {
  it("exports parsed rate-limit application from its own module", () => {
    expect(applyParsedRateLimits).toBeTypeOf("function");
    expect(applyRateLimitHeaders).toBeTypeOf("function");
    const rateLimitHelper = source(RATE_LIMIT_MODULE);

    expect(importsNamedBinding(rateLimitHelper, "rate-limit-headers.js", "rateLimitToQuota", RATE_LIMIT_MODULE)).toBe(true);
  });

  it("keeps parsed rate-limit account-pool mutation out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const upstreamAttempt = source(UPSTREAM_ATTEMPT_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-upstream-attempt.js", "sendProxyUpstreamAttempt", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-rate-limit.js", "applyParsedRateLimits", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(upstreamAttempt, "proxy-rate-limit.js", "applyParsedRateLimits", UPSTREAM_ATTEMPT_MODULE)).toBe(true);
    expect(importsNamedBinding(upstreamAttempt, "proxy-rate-limit.js", "applyRateLimitHeaders", UPSTREAM_ATTEMPT_MODULE)).toBe(true);
    expect(importedModuleSpecifiers(proxyHandler, PROXY_HANDLER_MODULE)).not.toEqual(expect.arrayContaining([
      "../../proxy/rate-limit-headers.js",
    ]));
    expect(importsNamedBinding(proxyHandler, "rate-limit-headers.js", "rateLimitToQuota", PROXY_HANDLER_MODULE)).toBe(false);
  });
});
