import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as sessionHelpers from "@src/routes/shared/proxy-session-helpers.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SESSION_HELPERS_MODULE = "src/routes/shared/proxy-session-helpers.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const IMPLICIT_RESUME_LIFECYCLE_MODULE = "src/routes/shared/proxy-implicit-resume-lifecycle.ts";
const IMPLICIT_RESUME_TEST = "tests/unit/routes/shared/proxy-handler-implicit-resume.test.ts";
const THIS_TEST = "tests/unit/routes/shared/proxy-session-helpers-boundary.test.ts";

const SESSION_HELPER_EXPORTS = [
  "IMPLICIT_RESUME_MAX_AGE_MS",
  "PromptCacheIdentity",
  "ImplicitResumeOpts",
  "normalizeInstructions",
  "resolvePromptCacheIdentity",
  "buildVariantIdentity",
  "evaluateImplicitResume",
  "shouldActivateImplicitResume",
  "shouldReplayFullInputAfterImplicitResumeError",
  "getContinuationInputStartIndex",
  "getFunctionCallOutputIds",
] as const;

const RUNTIME_SESSION_HELPER_EXPORTS = [
  "IMPLICIT_RESUME_MAX_AGE_MS",
  "normalizeInstructions",
  "resolvePromptCacheIdentity",
  "buildVariantIdentity",
  "evaluateImplicitResume",
  "shouldActivateImplicitResume",
  "shouldReplayFullInputAfterImplicitResumeError",
  "getContinuationInputStartIndex",
  "getFunctionCallOutputIds",
] as const;

const SESSION_HELPER_EXPORT_SET = new Set<string>(SESSION_HELPER_EXPORTS);

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

function parseSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function addDeclarationName(node: ts.NamedDeclaration, names: Set<string>): void {
  const declarationName = node.name;
  if (declarationName && ts.isIdentifier(declarationName)) {
    names.add(declarationName.text);
  }
}

function exportedNames(content: string, path = "inline.ts"): Set<string> {
  const file = parseSource(path, content);
  const names = new Set<string>();

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const exportClause = statement.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          names.add(element.name.text);
        }
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      addDeclarationName(statement, names);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    }
  }

  return names;
}

function declaredSessionHelperNames(content: string, path = "inline.ts"): string[] {
  const file = parseSource(path, content);
  const names = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      addDeclarationName(node, names);
    } else if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return [...names]
    .filter((name) => SESSION_HELPER_EXPORT_SET.has(name))
    .sort();
}

function moduleSpecifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
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

function isProxyHandlerModule(specifier: string): boolean {
  return /(?:^|\/)proxy-handler\.js$/.test(specifier);
}

function isProxySessionHelpersModule(specifier: string): boolean {
  return /(?:^|\/)proxy-session-helpers\.js$/.test(specifier);
}

function sessionHelperReExportNames(content: string, path = "inline.ts"): string[] {
  const file = parseSource(path, content);
  const names = new Set<string>();

  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    const specifier = moduleSpecifierText(statement);
    const exportClause = statement.exportClause;
    if (!exportClause) {
      if (specifier && isProxySessionHelpersModule(specifier)) {
        names.add("export * from proxy-session-helpers");
      }
      continue;
    }

    if (ts.isNamespaceExport(exportClause)) {
      if (specifier && isProxySessionHelpersModule(specifier)) {
        names.add(exportClause.name.text);
      }
      continue;
    }

    for (const element of exportClause.elements) {
      const referencedName = element.propertyName?.text ?? element.name.text;
      const exportedName = element.name.text;
      if (SESSION_HELPER_EXPORT_SET.has(referencedName) || SESSION_HELPER_EXPORT_SET.has(exportedName)) {
        names.add(referencedName);
      }
    }
  }

  return [...names].sort();
}

function tsFiles(dir: string): string[] {
  const absoluteDir = resolve(ROOT, dir);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    const absolutePath = join(absoluteDir, entry);
    const relativePath = absolutePath.slice(ROOT.length + 1);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...tsFiles(relativePath));
      continue;
    }
    if (relativePath !== THIS_TEST && relativePath.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

function importsSessionHelpersFromProxyHandler(content: string): boolean {
  const file = parseSource("inline.ts", content);

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const specifier = moduleSpecifierText(statement);
    if (!specifier || !isProxyHandlerModule(specifier)) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      return true;
    }

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (SESSION_HELPER_EXPORT_SET.has(importedName) || SESSION_HELPER_EXPORT_SET.has(localName)) {
        return true;
      }
    }
  }

  return false;
}

describe("proxy session helper boundary", () => {
  it("keeps prompt-cache and implicit-resume helpers in a dedicated module", () => {
    const helpers = source(SESSION_HELPERS_MODULE);
    const helperExports = exportedNames(helpers, SESSION_HELPERS_MODULE);
    const missingExports = SESSION_HELPER_EXPORTS.filter((exportName) => !helperExports.has(exportName));

    expect(missingExports).toEqual([]);
    for (const exportName of RUNTIME_SESSION_HELPER_EXPORTS) {
      expect(sessionHelpers).toHaveProperty(exportName);
    }
    expect(importedModuleSpecifiers(helpers, SESSION_HELPERS_MODULE)).toContain("./stable-conversation-key.js");
  });

  it("keeps session helper declarations out of the runtime proxy handler", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const lifecycle = source(IMPLICIT_RESUME_LIFECYCLE_MODULE);

    expect(declaredSessionHelperNames(proxyHandler, PROXY_HANDLER_MODULE)).toEqual([]);
    expect(sessionHelperReExportNames(proxyHandler, PROXY_HANDLER_MODULE)).toEqual([]);
    expect(importedModuleSpecifiers(proxyHandler, PROXY_HANDLER_MODULE)).not.toContain("./proxy-session-helpers.js");
    expect(importedModuleSpecifiers(lifecycle, IMPLICIT_RESUME_LIFECYCLE_MODULE)).toContain("./proxy-session-helpers.js");
  });

  it("keeps helper unit tests importing the helper module directly", () => {
    const testSource = source(IMPLICIT_RESUME_TEST);
    expect(testSource).toContain('from "@src/routes/shared/proxy-session-helpers.js"');
    expect(importsSessionHelpersFromProxyHandler(testSource)).toBe(false);
  });

  it("prevents session helpers from regressing back to proxy-handler.js imports", () => {
    const offenders = [...tsFiles("src"), ...tsFiles("tests")]
      .filter((file) => importsSessionHelpersFromProxyHandler(source(file)));

    expect(offenders).toEqual([]);
  });

  it("detects boundary regressions that string checks can miss", () => {
    const badProxyHandler = `
      export const resolvePromptCacheIdentity = () => "bad";
      export type ImplicitResumeOpts = { active: boolean };
      export { evaluateImplicitResume as renamedEval } from "./proxy-session-helpers.js";
      export * as sessionHelpers from "./proxy-session-helpers.js";
    `;
    const badImporter = `
      import * as proxyHandler from "@src/routes/shared/proxy-handler.js";
      import { resolvePromptCacheIdentity as resolve } from "@src/routes/shared/proxy-handler.js";
    `;

    expect(declaredSessionHelperNames(badProxyHandler)).toEqual([
      "ImplicitResumeOpts",
      "resolvePromptCacheIdentity",
    ]);
    expect(sessionHelperReExportNames(badProxyHandler)).toEqual([
      "evaluateImplicitResume",
      "sessionHelpers",
    ]);
    expect(importsSessionHelpersFromProxyHandler(badImporter)).toBe(true);
  });
});
