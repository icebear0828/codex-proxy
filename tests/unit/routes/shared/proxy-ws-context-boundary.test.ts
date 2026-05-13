import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildWsPoolContext } from "@src/routes/shared/proxy-ws-context.js";

const ROOT = process.cwd();
const WS_CONTEXT_MODULE = "src/routes/shared/proxy-ws-context.ts";
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

describe("proxy websocket context boundary", () => {
  it("exports websocket pool context construction from its own module", () => {
    expect(buildWsPoolContext).toBeTypeOf("function");
    const wsContext = source(WS_CONTEXT_MODULE);

    expect(importsNamedBinding(wsContext, "ws-pool.js", "getWsPool", WS_CONTEXT_MODULE)).toBe(true);
    expect(importsNamedBinding(wsContext, "codex-api.js", "WsPoolContext", WS_CONTEXT_MODULE)).toBe(true);
  });

  it("keeps websocket pool singleton wiring out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-ws-context.js", "buildWsPoolContext", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "ws-pool.js", "getWsPool", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "codex-api.js", "WsPoolContext", PROXY_HANDLER_MODULE)).toBe(false);
  });
});
