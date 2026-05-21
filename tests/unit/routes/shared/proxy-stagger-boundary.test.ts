import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { staggerIfNeeded } from "@src/routes/shared/proxy-stagger.js";

const ROOT = process.cwd();
const STAGGER_MODULE = "src/routes/shared/proxy-stagger.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const RESPONSES_MODULE = "src/routes/responses.ts";

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

describe("proxy stagger helper boundary", () => {
  it("exports request staggering from its own module", () => {
    expect(staggerIfNeeded).toBeTypeOf("function");
    const staggerHelper = source(STAGGER_MODULE);

    expect(importsNamedBinding(staggerHelper, "config.js", "getConfig", STAGGER_MODULE)).toBe(true);
    expect(importsNamedBinding(staggerHelper, "jitter.js", "jitterInt", STAGGER_MODULE)).toBe(true);
  });

  it("keeps request staggering dependencies out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-stagger.js", "staggerIfNeeded", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "config.js", "getConfig", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(proxyHandler, "jitter.js", "jitterInt", PROXY_HANDLER_MODULE)).toBe(false);
  });

  it("keeps compact responses from importing utility functions from the runtime handler", () => {
    const responses = source(RESPONSES_MODULE);

    expect(importsNamedBinding(responses, "shared/proxy-stagger.js", "staggerIfNeeded", RESPONSES_MODULE)).toBe(true);
    expect(importsNamedBinding(responses, "shared/proxy-handler.js", "handleProxyRequest", RESPONSES_MODULE)).toBe(true);
    expect(importsNamedBinding(responses, "shared/proxy-handler.js", "staggerIfNeeded", RESPONSES_MODULE)).toBe(false);
  });
});
