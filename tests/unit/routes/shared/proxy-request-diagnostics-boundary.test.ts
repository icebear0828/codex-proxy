import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildRequestDiagnostics,
  logRequestDiagnostics,
} from "@src/routes/shared/proxy-request-diagnostics.js";

const ROOT = process.cwd();
const DIAGNOSTICS_MODULE = "src/routes/shared/proxy-request-diagnostics.ts";
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

describe("proxy request diagnostics boundary", () => {
  it("exports request diagnostic formatting from its own module", () => {
    expect(buildRequestDiagnostics).toBeTypeOf("function");
    expect(logRequestDiagnostics).toBeTypeOf("function");
    const diagnostics = source(DIAGNOSTICS_MODULE);

    expect(diagnostics).toContain("payloadBytes");
    expect(diagnostics).toContain("largePayloadWarning");
  });

  it("keeps request diagnostic formatting out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-request-diagnostics.js", "logRequestDiagnostics", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-request-diagnostics.js", "buildRequestDiagnostics", PROXY_HANDLER_MODULE)).toBe(false);
    expect(proxyHandler).not.toContain("JSON.stringify(req.codexRequest)");
    expect(proxyHandler).not.toContain("diagnostics.summary");
    expect(proxyHandler).not.toContain("largePayloadWarning");
    expect(proxyHandler).not.toContain("Large payload");
    expect(proxyHandler).not.toContain("itemSizes");
  });
});
