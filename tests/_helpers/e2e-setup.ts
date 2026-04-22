/**
 * Shared E2E test setup — declares all vi.mock() calls for the external boundary.
 *
 * Usage: import this file BEFORE any @src/ imports in your e2e test.
 *
 *   import { ... } from "@helpers/e2e-setup.js";
 *   // then import @src/ modules
 *
 * Mocked modules (external boundary):
 *   - @src/tls/transport.js — controllable transport via setTransportPost()
 *   - @src/tls/curl-binary.js — no-op
 *   - @src/config.js — returns createMockConfig()/createMockFingerprint()
 *   - @src/paths.js — returns /tmp/codex-e2e/ paths
 *   - fs — intercepts readFileSync for models.yaml, desktop-context.md, index.html;
 *          models.yaml content is loaded from tests/_fixtures/models.yaml via importOriginal
 *   - @src/update-checker.js, @src/self-update.js, @src/models/model-fetcher.js — no-op
 *   - @hono/node-server/serve-static — passthrough middleware
 *
 * Real modules (run unmodified):
 *   AccountPool, CookieJar, ProxyPool, CodexApi, withRetry,
 *   all translation layers, all middleware, all routes, fingerprint manager, model store
 */

import { vi } from "vitest";
import { resolve } from "path";
import type { TlsTransportResponse, TlsTransport } from "@src/tls/transport.js";
import { createMockConfig, createMockFingerprint } from "@helpers/config.js";

const mockConfig = createMockConfig();
const mockFingerprint = createMockFingerprint();

// ── Transport mock ───────────────────────────────────────────────────

export type TransportPostFn = (
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
  timeoutSec?: number,
  proxyUrl?: string | null,
) => Promise<TlsTransportResponse>;

let _transportPost: TransportPostFn;
let _lastTransportBody: string | null = null;

/** Override the transport.post behavior for the current test. */
export function setTransportPost(fn: TransportPostFn): void {
  _transportPost = fn;
}

/** Get the last request body sent to transport.post (or null). */
export function getLastTransportBody(): string | null {
  return _lastTransportBody;
}

/** Reset transport capture state. Call in beforeEach. */
export function resetTransportState(): void {
  _lastTransportBody = null;
}

const mockTransport: TlsTransport = {
  post: vi.fn((...args: Parameters<TlsTransport["post"]>) => {
    _lastTransportBody = args[2];
    return _transportPost(args[0], args[1], args[2], args[3], args[4], args[5]);
  }),
  get: vi.fn(async () => ({ status: 200, body: "{}" })),
  simplePost: vi.fn(async () => ({ status: 200, body: "{}" })),
  isImpersonate: () => false,
};

/** Get the mock transport instance (for mockClear etc.). */
export function getMockTransport(): TlsTransport {
  return mockTransport;
}

// ── Transport response builders ──────────────────────────────────────

/** Build a TlsTransportResponse wrapping SSE text. */
export function makeTransportResponse(sseText: string, status = 200): TlsTransportResponse {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

/** Build a TlsTransportResponse for error cases (JSON body). */
export function makeErrorTransportResponse(status: number, body: string): TlsTransportResponse {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

// ── vi.mock declarations (hoisted by vitest) ─────────────────────────

vi.mock("@src/tls/transport.js", () => ({
  initTransport: vi.fn(async () => mockTransport),
  resetTransport: vi.fn(),
  getTransport: vi.fn(() => mockTransport),
}));

vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: vi.fn(async (
    wsUrl: string,
    headers: Record<string, string>,
    request: unknown,
    signal?: AbortSignal,
    proxyUrl?: string | null,
  ) => {
    const body = JSON.stringify(request);
    _lastTransportBody = body;
    const result = await _transportPost(wsUrl, headers, body, signal, undefined, proxyUrl);
    if (result.status < 200 || result.status >= 300) {
      const errorBody = await new Response(result.body as BodyInit).text();
      const { CodexApiError } = await import("@src/proxy/codex-types.js");
      throw new CodexApiError(result.status, errorBody);
    }
    return new Response(result.body as BodyInit, {
      status: result.status,
      headers: result.headers,
    });
  }),
}));

vi.mock("@src/tls/curl-binary.js", () => ({
  initProxy: vi.fn(async () => {}),
  getCurlBinary: vi.fn(() => null),
  isImpersonate: vi.fn(() => false),
  supportsCompressed: vi.fn(() => true),
}));

vi.mock("@src/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
  loadFingerprint: vi.fn(() => mockFingerprint),
  getConfig: vi.fn(() => mockConfig),
  getFingerprint: vi.fn(() => mockFingerprint),
  mutateClientConfig: vi.fn(),
  reloadAllConfigs: vi.fn(),
  reloadConfig: vi.fn(() => mockConfig),
  reloadFingerprint: vi.fn(() => mockFingerprint),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/codex-e2e/config"),
  getDataDir: vi.fn(() => "/tmp/codex-e2e/data"),
  getBinDir: vi.fn(() => "/tmp/codex-e2e/bin"),
  getPublicDir: vi.fn(() => "/tmp/codex-e2e/public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/codex-e2e/public-desktop"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  // Read fixture with real fs before returning the mocked version
  const modelsYaml = actual.readFileSync(
    resolve(process.cwd(), "tests/_fixtures/models.yaml"),
    "utf-8",
  ) as string;

  return {
    ...actual,
    readFileSync: vi.fn((path: string, _enc?: string) => {
      if (typeof path === "string" && path.includes("models.yaml")) return modelsYaml;
      if (typeof path === "string" && path.includes("desktop-context.md")) return "";
      if (typeof path === "string" && path.includes("index.html")) return "<html>test</html>";
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }),
    existsSync: vi.fn((p: string) => typeof p === "string" && p.includes("models.yaml")),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("@src/update-checker.js", () => ({
  startUpdateChecker: vi.fn(),
  stopUpdateChecker: vi.fn(),
  getUpdateState: vi.fn(() => null),
  checkForUpdate: vi.fn(async () => ({
    update_available: false, current_version: "test", latest_version: null,
  })),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/self-update.js", () => ({
  startProxyUpdateChecker: vi.fn(),
  stopProxyUpdateChecker: vi.fn(),
  getProxyInfo: vi.fn(() => ({ version: "test", commit: "abc" })),
  canSelfUpdate: vi.fn(() => false),
  getDeployMode: vi.fn(() => "git"),
  getCachedProxyUpdateResult: vi.fn(() => null),
  checkProxySelfUpdate: vi.fn(async () => ({
    commitsBehind: 0, commits: [], release: null, updateAvailable: false,
    mode: "git", currentCommit: "abc", latestCommit: "abc",
  })),
  applyProxySelfUpdate: vi.fn(async () => ({ started: false })),
  isProxyUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
  triggerImmediateRefresh: vi.fn(),
}));

vi.mock("@src/auth/usage-refresher.js", () => ({
  startQuotaRefresh: vi.fn(),
  stopQuotaRefresh: vi.fn(),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));
