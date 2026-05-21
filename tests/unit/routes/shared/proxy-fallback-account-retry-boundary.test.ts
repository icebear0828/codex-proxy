import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as fallbackAccountRetry from "@src/routes/shared/proxy-fallback-account-retry.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const FALLBACK_ACCOUNT_RETRY_MODULE = "src/routes/shared/proxy-fallback-account-retry.ts";
const ERROR_RETRY_TRANSITION_MODULE = "src/routes/shared/proxy-error-retry-transition.ts";

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

describe("proxy fallback account retry boundary", () => {
  it("exports the fallback account retry helper", () => {
    expect(fallbackAccountRetry.prepareProxyFallbackAccountRetry).toBeTypeOf("function");
  });

  it("keeps fallback availability and account reacquire details out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const fallbackRetry = source(FALLBACK_ACCOUNT_RETRY_MODULE);
    const errorRetryTransition = source(ERROR_RETRY_TRANSITION_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-fallback-account-retry.js",
      "prepareProxyFallbackAccountRetry",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(
      errorRetryTransition,
      "proxy-fallback-account-retry.js",
      "prepareProxyFallbackAccountRetry",
      ERROR_RETRY_TRANSITION_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-fallback-retry-plan.js",
      "buildProxyFallbackRetryPlan",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(proxyHandler).not.toContain("accountPool.hasAvailableAccounts(triedEntryIds)");
    expect(proxyHandler).not.toContain("accountPool.getPoolSummary()");
    expect(proxyHandler).not.toContain("Fallback \u2192 account");

    expect(importsNamedBinding(
      fallbackRetry,
      "proxy-fallback-retry-plan.js",
      "buildProxyFallbackRetryPlan",
      FALLBACK_ACCOUNT_RETRY_MODULE,
    )).toBe(true);
  });

  it("does not let the fallback account helper own request restore or response rendering", () => {
    const fallbackRetry = source(FALLBACK_ACCOUNT_RETRY_MODULE);

    expect(importedModuleSpecifiers(fallbackRetry, FALLBACK_ACCOUNT_RETRY_MODULE)).not.toEqual(expect.arrayContaining([
      "./proxy-implicit-resume-lifecycle.js",
      "./proxy-implicit-resume-request.js",
      "./proxy-retry-recovery.js",
      "./proxy-error-response.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "hono",
    ]));
  });
});
