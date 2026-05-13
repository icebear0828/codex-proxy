import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TYPE_MODULE = "src/routes/shared/proxy-handler-types.ts";
const HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const THIS_TEST = "tests/unit/routes/shared/proxy-handler-type-boundary.test.ts";

const SHARED_CONTRACTS = [
  "ProxyRequest",
  "UsageHint",
  "ResponseMetadata",
  "FormatStreamTranslatorOptions",
  "FormatCollectTranslatorOptions",
  "FormatCollectTranslatorResult",
  "FormatAdapter",
  "HandleProxyRequestOptions",
  "HandleDirectRequestOptions",
] as const;
const SHARED_CONTRACT_SET = new Set<string>(SHARED_CONTRACTS);

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
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

function importedNamesFromProxyHandler(content: string): string[] {
  const imports = content.matchAll(
    /import\s+(?:type\s+)?{(?<names>[\s\S]*?)}\s+from\s+["'][^"']*proxy-handler\.js["'];/g,
  );
  const names: string[] = [];
  for (const importStatement of imports) {
    const rawNames = importStatement.groups?.names;
    if (!rawNames) continue;
    for (const rawName of rawNames.split(",")) {
      const name = rawName
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("proxy handler type boundary", () => {
  it("detects shared contracts in both mixed and type-only proxy-handler imports", () => {
    expect(importedNamesFromProxyHandler(
      'import { handleProxyRequest, type FormatAdapter } from "./proxy-handler.js";',
    )).toEqual(["handleProxyRequest", "FormatAdapter"]);
    expect(importedNamesFromProxyHandler(
      'import type { ProxyRequest, FormatAdapter } from "./proxy-handler.js";',
    )).toEqual(["ProxyRequest", "FormatAdapter"]);
  });

  it("keeps shared proxy contracts in a dedicated type module", () => {
    const typeModule = source(TYPE_MODULE);
    for (const contractName of SHARED_CONTRACTS) {
      expect(typeModule).toContain(`export interface ${contractName}`);
    }
    expect(typeModule).not.toContain("proxy-handler.js");
  });

  it("keeps shared contract declarations out of the runtime handler", () => {
    const proxyHandler = source(HANDLER_MODULE);
    for (const contractName of SHARED_CONTRACTS) {
      expect(proxyHandler).not.toContain(`export interface ${contractName}`);
    }
    expect(proxyHandler).toContain('from "./proxy-handler-types.js"');
  });

  it("prevents helper modules from importing the runtime handler just for shared types", () => {
    const responseProcessor = source("src/routes/shared/response-processor.ts");
    const nonStreamingHandler = source("src/routes/shared/non-streaming-handler.ts");

    expect(responseProcessor).not.toContain('from "./proxy-handler.js"');
    expect(nonStreamingHandler).not.toContain('from "./proxy-handler.js"');
    expect(responseProcessor).toContain('from "./proxy-handler-types.js"');
    expect(nonStreamingHandler).toContain('from "./proxy-handler-types.js"');
  });

  it("prevents shared type imports from regressing back to proxy-handler.js", () => {
    const offenders: string[] = [];
    for (const file of [...tsFiles("src"), ...tsFiles("tests")]) {
      const importedContracts = importedNamesFromProxyHandler(source(file))
        .filter((name) => SHARED_CONTRACT_SET.has(name));
      for (const contractName of importedContracts) {
        offenders.push(`${file}: ${contractName}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
