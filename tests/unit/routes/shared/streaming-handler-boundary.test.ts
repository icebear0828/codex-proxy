import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { handleStreaming } from "@src/routes/shared/streaming-handler.js";
import { createResponseMetadataCollector } from "@src/routes/shared/response-metadata-collector.js";

const ROOT = process.cwd();
const STREAMING_HANDLER_MODULE = "src/routes/shared/streaming-handler.ts";
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

function exportedNames(content: string, path = "inline.ts"): string[] {
  const file = parseSource(path, content);
  const names = new Set<string>();

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) {
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    }
  }

  return [...names].sort();
}

describe("streaming handler module boundary", () => {
  it("exports the streaming response handler from its own module", () => {
    expect(handleStreaming).toBeTypeOf("function");
    expect(createResponseMetadataCollector).toBeTypeOf("function");
    const streamingHandler = source(STREAMING_HANDLER_MODULE);
    expect(exportedNames(streamingHandler, STREAMING_HANDLER_MODULE)).toContain("handleStreaming");
    expect(importsNamedBinding(streamingHandler, "response-processor.js", "streamResponse", STREAMING_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(streamingHandler, "stream-close-event.js", "recordStreamCloseEvent", STREAMING_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(
      streamingHandler,
      "response-metadata-collector.js",
      "createResponseMetadataCollector",
      STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(streamingHandler).not.toContain("new Set<string>()");
    expect(streamingHandler).not.toContain("metadata.functionCallIds");
  });

  it("keeps streaming response details out of the runtime proxy handler", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    expect(importsNamedBinding(proxyHandler, "streaming-handler.js", "handleStreaming", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importedModuleSpecifiers(proxyHandler, PROXY_HANDLER_MODULE)).not.toEqual(expect.arrayContaining([
      "hono/streaming",
      "./response-processor.js",
      "../../logs/stream-close-event.js",
    ]));
    expect(importsNamedBinding(proxyHandler, "response-processor.js", "streamResponse", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "stream-close-event.js", "recordStreamCloseEvent", PROXY_HANDLER_MODULE)).toBe(false);
  });
});
