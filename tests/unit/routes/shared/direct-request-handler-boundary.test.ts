import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIRECT_HANDLER_MODULE = "src/routes/shared/direct-request-handler.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";
const THIS_TEST = "tests/unit/routes/shared/direct-request-handler-boundary.test.ts";

const DIRECT_ROUTE_FILES = [
  "src/routes/chat.ts",
  "src/routes/messages.ts",
  "src/routes/gemini.ts",
  "src/routes/responses.ts",
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

function importsHandleDirectRequestFromProxyHandler(content: string): boolean {
  const imports = content.matchAll(
    /import\s+{(?<names>[\s\S]*?)}\s+from\s+["'][^"']*proxy-handler\.js["'];/g,
  );
  for (const importStatement of imports) {
    const rawNames = importStatement.groups?.names;
    if (!rawNames) continue;
    const names = rawNames
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim())
      .filter((name): name is string => Boolean(name));
    if (names.includes("handleDirectRequest")) return true;
  }
  return false;
}

function proxyHandlerMockBodiesWithDirectHandler(content: string): string[] {
  const mocks = content.matchAll(
    /vi\.mock\(["']@src\/routes\/shared\/proxy-handler\.js["'],\s*\(\)\s*=>\s*\(\{(?<body>[\s\S]*?)\}\)\);/g,
  );
  const bodies: string[] = [];
  for (const mock of mocks) {
    const body = mock.groups?.body;
    if (body?.includes("handleDirectRequest")) bodies.push(body);
  }
  return bodies;
}

describe("direct request handler boundary", () => {
  it("keeps direct upstream handling in a dedicated module", () => {
    const directHandler = source(DIRECT_HANDLER_MODULE);
    expect(directHandler).toContain("export async function handleDirectRequest");
    expect(directHandler).toContain("HandleDirectRequestOptions");
  });

  it("keeps direct upstream handling free of account-backed proxy dependencies", () => {
    const directHandler = source(DIRECT_HANDLER_MODULE);
    const forbiddenDependencies = [
      "account-acquisition",
      "AccountPool",
      "CookieJar",
      "ProxyPool",
      "withRetry",
      "session-affinity",
      "proxy-handler.js",
    ];

    for (const dependency of forbiddenDependencies) {
      expect(directHandler).not.toContain(dependency);
    }
  });

  it("keeps proxy-handler focused on account-backed proxy orchestration", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    expect(proxyHandler).not.toContain("export async function handleDirectRequest");
    expect(proxyHandler).not.toContain("Lightweight handler for API-key-based upstreams");
    expect(proxyHandler).not.toContain("function streamErrorResponse");
    expect(proxyHandler).not.toContain("function canReturnStreamError");
  });

  it("routes import direct upstream handling from the direct handler module", () => {
    for (const routeFile of DIRECT_ROUTE_FILES) {
      const route = source(routeFile);
      expect(route).toContain('handleDirectRequest');
      expect(route).toContain('from "./shared/direct-request-handler.js"');
      expect(importsHandleDirectRequestFromProxyHandler(route)).toBe(false);
    }
  });

  it("prevents handleDirectRequest imports from regressing back to proxy-handler.js", () => {
    const offenders = [...tsFiles("src"), ...tsFiles("tests")]
      .filter((file) => importsHandleDirectRequestFromProxyHandler(source(file)));

    expect(offenders).toEqual([]);
  });

  it("prevents proxy-handler mocks from claiming handleDirectRequest", () => {
    const offenders = [...tsFiles("tests")]
      .filter((file) => proxyHandlerMockBodiesWithDirectHandler(source(file)).length > 0);

    expect(offenders).toEqual([]);
  });
});
