import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SESSION_HELPERS_MODULE = "src/routes/shared/proxy-session-helpers.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
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

function importsSessionHelpersFromProxyHandler(content: string): boolean {
  const imports = content.matchAll(
    /import\s+(?:type\s+)?{(?<names>[\s\S]*?)}\s+from\s+["'][^"']*proxy-handler\.js["'];/g,
  );
  for (const importStatement of imports) {
    const rawNames = importStatement.groups?.names;
    if (!rawNames) continue;
    const names = rawNames
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim())
      .filter((name): name is string => Boolean(name));
    if (names.some((name) => SESSION_HELPER_EXPORTS.includes(name as typeof SESSION_HELPER_EXPORTS[number]))) {
      return true;
    }
  }
  return false;
}

describe("proxy session helper boundary", () => {
  it("keeps prompt-cache and implicit-resume helpers in a dedicated module", () => {
    const helpers = source(SESSION_HELPERS_MODULE);
    for (const exportName of SESSION_HELPER_EXPORTS) {
      expect(helpers).toContain(exportName);
    }
    expect(helpers).toContain('from "./stable-conversation-key.js"');
  });

  it("keeps session helper declarations out of the runtime proxy handler", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    for (const exportName of SESSION_HELPER_EXPORTS) {
      expect(proxyHandler).not.toContain(`export function ${exportName}`);
      expect(proxyHandler).not.toContain(`function ${exportName}`);
      expect(proxyHandler).not.toContain(`export interface ${exportName}`);
    }
    expect(proxyHandler).toContain('from "./proxy-session-helpers.js"');
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
});
