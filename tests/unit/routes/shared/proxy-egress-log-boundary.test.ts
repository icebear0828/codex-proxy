import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { recordProxyEgressLog } from "@src/routes/shared/proxy-egress-log.js";

const ROOT = process.cwd();
const EGRESS_LOG_MODULE = "src/routes/shared/proxy-egress-log.ts";
const UPSTREAM_ATTEMPT_MODULE = "src/routes/shared/proxy-upstream-attempt.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const NON_STREAMING_HANDLER_MODULE = "src/routes/shared/non-streaming-handler.ts";

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

describe("proxy egress log boundary", () => {
  it("exports Codex egress logging from its own module", () => {
    expect(recordProxyEgressLog).toBeTypeOf("function");
    const egressLogHelper = source(EGRESS_LOG_MODULE);

    expect(importsNamedBinding(egressLogHelper, "entry.js", "enqueueLogEntry", EGRESS_LOG_MODULE)).toBe(true);
  });

  it("keeps log-store enqueue wiring out of the proxy orchestrator", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    const upstreamAttempt = source(UPSTREAM_ATTEMPT_MODULE);

    expect(importsNamedBinding(proxyHandler, "proxy-upstream-attempt.js", "sendProxyUpstreamAttempt", PROXY_HANDLER_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "proxy-egress-log.js", "recordProxyEgressLog", PROXY_HANDLER_MODULE)).toBe(false);
    expect(importsNamedBinding(upstreamAttempt, "proxy-egress-log.js", "recordProxyEgressLog", UPSTREAM_ATTEMPT_MODULE)).toBe(true);
    expect(importsNamedBinding(proxyHandler, "entry.js", "enqueueLogEntry", PROXY_HANDLER_MODULE)).toBe(false);
    expect(proxyHandler).not.toContain('path: "/codex/responses"');
  });

  it("keeps log-store enqueue wiring out of non-streaming retry handling", () => {
    const nonStreamingHandler = source(NON_STREAMING_HANDLER_MODULE);

    expect(importsNamedBinding(
      nonStreamingHandler,
      "proxy-egress-log.js",
      "recordProxyEgressLog",
      NON_STREAMING_HANDLER_MODULE,
    )).toBe(true);
    expect(importsNamedBinding(nonStreamingHandler, "entry.js", "enqueueLogEntry", NON_STREAMING_HANDLER_MODULE)).toBe(false);
    expect(nonStreamingHandler).not.toContain('path: "/codex/responses"');
  });
});
