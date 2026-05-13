import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as implicitResumeLifecycle from "@src/routes/shared/proxy-implicit-resume-lifecycle.js";
import * as implicitResumeRequest from "@src/routes/shared/proxy-implicit-resume-request.js";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const IMPLICIT_RESUME_LIFECYCLE_MODULE = "src/routes/shared/proxy-implicit-resume-lifecycle.ts";
const IMPLICIT_RESUME_REQUEST_MODULE = "src/routes/shared/proxy-implicit-resume-request.ts";

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

describe("proxy implicit resume request helper boundary", () => {
  it("exports request state helpers from their own module", () => {
    expect(implicitResumeRequest.captureImplicitResumeRequestState).toBeTypeOf("function");
    expect(implicitResumeRequest.applyImplicitResumeRequest).toBeTypeOf("function");
    expect(implicitResumeRequest.restoreImplicitResumeRequestState).toBeTypeOf("function");
    expect(implicitResumeLifecycle.createImplicitResumeLifecycle).toBeTypeOf("function");
  });

  it("keeps implicit-resume request mutation details out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const lifecycle = source(IMPLICIT_RESUME_LIFECYCLE_MODULE);

    expect(importsNamedBinding(
      proxyHandler,
      "proxy-implicit-resume-request.js",
      "captureImplicitResumeRequestState",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-implicit-resume-lifecycle.js",
      "createImplicitResumeLifecycle",
      PROXY_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-implicit-resume-request.js",
      "applyImplicitResumeRequest",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(
      proxyHandler,
      "proxy-implicit-resume-request.js",
      "restoreImplicitResumeRequestState",
      PROXY_HANDLER_MODULE,
    )).toBe(false);
    expect(importsNamedBinding(
      lifecycle,
      "proxy-implicit-resume-request.js",
      "applyImplicitResumeRequest",
      IMPLICIT_RESUME_LIFECYCLE_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(
      lifecycle,
      "proxy-implicit-resume-request.js",
      "restoreImplicitResumeRequestState",
      IMPLICIT_RESUME_LIFECYCLE_MODULE,
    )).toBe(true);
    expect(proxyHandler).not.toContain("req.codexRequest.previous_response_id = implicitPrevRespId!");
    expect(proxyHandler).not.toContain("req.codexRequest.input = req.codexRequest.input.slice(continuationInputStart)");
  });

  it("keeps account lifecycle side effects out of the implicit-resume request helper", () => {
    const helper = source(IMPLICIT_RESUME_REQUEST_MODULE);

    expect(importedModuleSpecifiers(helper, IMPLICIT_RESUME_REQUEST_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-handler-utils.js",
      "./proxy-stagger.js",
      "./proxy-handler.js",
      "hono",
    ]));
  });

  it("keeps account fallback, retry recovery, and response handling out of the implicit-resume lifecycle", () => {
    const lifecycle = source(IMPLICIT_RESUME_LIFECYCLE_MODULE);

    expect(importedModuleSpecifiers(lifecycle, IMPLICIT_RESUME_LIFECYCLE_MODULE)).not.toEqual(expect.arrayContaining([
      "./account-acquisition.js",
      "./proxy-fallback-retry-plan.js",
      "./proxy-retry-recovery.js",
      "./streaming-handler.js",
      "./non-streaming-handler.js",
      "./proxy-ws-context.js",
      "./proxy-handler.js",
      "hono",
    ]));
  });
});
