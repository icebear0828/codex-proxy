import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { dumpProxyRequest } from "@src/routes/shared/proxy-debug-dump.js";

const ROOT = process.cwd();
const DEBUG_DUMP_MODULE = "src/routes/shared/proxy-debug-dump.ts";
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
  return ts.isStringLiteralLike(moduleSpecifier) ? moduleSpecifier.text : null;
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

describe("proxy debug dump boundary", () => {
  it("exports request debug dump wiring from its own module", () => {
    expect(dumpProxyRequest).toBeTypeOf("function");
    const debugDumpHelper = source(DEBUG_DUMP_MODULE);

    expect(importsNamedBinding(debugDumpHelper, "debug-dump.js", "debugDump", DEBUG_DUMP_MODULE)).toBe(true);
    expect(importsNamedBinding(debugDumpHelper, "debug-dump.js", "debugDumpEnabled", DEBUG_DUMP_MODULE)).toBe(true);
  });

  it("keeps debug dump utility wiring out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const upstreamAttempt = source(UPSTREAM_ATTEMPT_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-upstream-attempt.js", "sendProxyUpstreamAttempt", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-debug-dump.js", "dumpProxyRequest", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(upstreamAttempt, "proxy-debug-dump.js", "dumpProxyRequest", UPSTREAM_ATTEMPT_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "debug-dump.js", "debugDump", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "debug-dump.js", "debugDumpEnabled", PROXY_HANDLER_MODULE)).toBe(false);
    expect(proxyHandler).not.toContain('debugDump("request"');
  });
});
