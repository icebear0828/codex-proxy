/**
 * Resolves the curl binary and Chrome TLS profile args.
 *
 * When curl-impersonate is available, we call it directly (NOT via the
 * curl_chrome136 wrapper script) and pass the TLS-level parameters ourselves.
 * This avoids duplicate -H headers between the wrapper and our fingerprint manager.
 *
 * The Chrome TLS args are extracted from curl_chrome136 wrapper script.
 * HTTP headers (-H flags) are intentionally excluded — our fingerprint manager
 * in manager.ts handles those to match Codex Desktop exactly.
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { createConnection } from "net";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getBinDir } from "../paths.js";

const IS_WIN = process.platform === "win32";
const BINARY_NAME = IS_WIN ? "curl-impersonate.exe" : "curl-impersonate";

/**
 * Chrome 136 TLS profile parameters.
 * Extracted from curl_chrome136 wrapper (lexiforest/curl-impersonate v1.4.4).
 * These control TLS fingerprint, HTTP/2 framing, and protocol negotiation.
 * HTTP-level headers are NOT included — our fingerprint manager handles those.
 */
const CHROME_TLS_ARGS: string[] = [
  // ── TLS cipher suites (exact Chrome 136 order) ──
  "--ciphers",
  [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
  ].join(":"),
  // ── Elliptic curves (includes post-quantum X25519MLKEM768) ──
  "--curves", "X25519MLKEM768:X25519:P-256:P-384",
  // ── HTTP/2 with Chrome-exact SETTINGS frame ──
  "--http2",
  "--http2-settings", "1:65536;2:0;4:6291456;6:262144",
  "--http2-window-update", "15663105",
  "--http2-stream-weight", "256",
  "--http2-stream-exclusive", "1",
  // ── TLS extensions (Chrome fingerprint) ──
  "--tlsv1.2",
  "--alps",
  "--tls-permute-extensions",
  "--cert-compression", "brotli",
  "--tls-grease",
  "--tls-use-new-alps-codepoint",
  "--tls-signed-cert-timestamps",
  "--ech", "grease",
  // ── Compression & cookies ──
  "--compressed",
];

let _resolved: string | null = null;
let _isImpersonate = false;
let _tlsArgs: string[] | null = null;
let _resolvedProfile = "chrome136";

/**
 * Resolve the curl binary path. Result is cached after first call.
 */
export function resolveCurlBinary(): string {
  if (_resolved) return _resolved;

  const config = getConfig();
  const setting = config.tls.curl_binary;

  if (setting !== "auto") {
    _resolved = setting;
    _isImpersonate = setting.includes("curl-impersonate");
    console.log(`[TLS] Using configured curl binary: ${_resolved}`);
    return _resolved;
  }

  // Auto-detect: look for curl-impersonate in bin/
  const binPath = resolve(getBinDir(), BINARY_NAME);
  if (existsSync(binPath)) {
    _resolved = binPath;
    _isImpersonate = true;
    console.log(`[TLS] Using curl-impersonate: ${_resolved}`);
    return _resolved;
  }

  // Fallback to system curl
  _resolved = "curl";
  _isImpersonate = false;
  console.warn(
    `[TLS] curl-impersonate not found at ${binPath}. ` +
    `Falling back to system curl. Run "npm/pnpm/bun run setup" to install curl-impersonate.`,
  );
  return _resolved;
}

/**
 * Chrome versions with distinct TLS fingerprints in curl-impersonate.
 * Only these versions are valid --impersonate targets.
 * Sorted ascending — update when curl-impersonate adds new profiles.
 */
const KNOWN_CHROME_PROFILES = [99, 100, 101, 104, 107, 110, 116, 119, 120, 123, 124, 131, 136];

/**
 * Map a configured profile to the nearest known-supported version.
 * e.g. "chrome137" → "chrome136", "chrome125" → "chrome124"
 * Non-chrome profiles (e.g. "firefox") are passed through unchanged.
 */
function resolveProfile(configured: string): string {
  const match = configured.match(/^chrome(\d+)$/);
  if (!match) return configured;

  const ver = parseInt(match[1], 10);
  let best: number | undefined;
  for (const known of KNOWN_CHROME_PROFILES) {
    if (known <= ver) best = known;
  }
  if (!best) return configured;

  const resolved = `chrome${best}`;
  if (resolved !== configured) {
    console.warn(`[TLS] Profile "${configured}" not in known targets, using "${resolved}"`);
  }
  return resolved;
}

/**
 * Detect if curl-impersonate supports the --impersonate flag.
 * Validates the configured profile and auto-falls back to the nearest
 * supported Chrome version if needed.
 */
function detectImpersonateSupport(binary: string): string[] {
  try {
    const helpOutput = execFileSync(binary, ["--help", "all"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (helpOutput.includes("--impersonate")) {
      const configured = getConfig().tls.impersonate_profile ?? "chrome136";
      const profile = resolveProfile(configured);
      _resolvedProfile = profile;
      console.log(`[TLS] Using --impersonate ${profile}`);
      return ["--impersonate", profile];
    }
  } catch {
    // --help failed, fall back to manual args
  }
  return CHROME_TLS_ARGS;
}

/**
 * Get Chrome TLS profile args to prepend to curl commands.
 * Returns empty array when using system curl (args are curl-impersonate specific).
 * Uses --impersonate flag when available, otherwise falls back to manual CHROME_TLS_ARGS.
 * When force_http11 is enabled, adds --http1.1 to force HTTP/1.1 protocol.
 */
export function getChromeTlsArgs(): string[] {
  // Ensure binary is resolved first
  resolveCurlBinary();
  if (!_isImpersonate) return [];
  if (!_tlsArgs) {
    _tlsArgs = detectImpersonateSupport(_resolved!);
  }
  const args = [..._tlsArgs];
  // Force HTTP/1.1 when configured (for proxies that don't support HTTP/2)
  const config = getConfig();
  if (config.tls.force_http11) {
    args.push("--http1.1");
  }
  return args;
}

/**
 * Common local proxy ports to auto-detect.
 * Checked in order: mihomo/clash, v2ray, SOCKS5 common.
 */
const PROXY_PORTS = [
  { port: 7890, proto: "http" },   // mihomo / clash
  { port: 7897, proto: "http" },   // clash-verge
  { port: 10809, proto: "http" },  // v2ray HTTP
  { port: 1080, proto: "socks5" }, // SOCKS5 common
  { port: 10808, proto: "socks5" },// v2ray SOCKS5
];

/**
 * Hosts to probe for proxy detection.
 * 127.0.0.1 — bare-metal / host machine.
 * host.docker.internal — Docker container → host machine
 * (DNS lookup fails on bare-metal → ENOTFOUND → handled by error callback, <5ms).
 */
const PROXY_HOSTS = ["127.0.0.1", "host.docker.internal"];

let _proxyUrl: string | null | undefined; // undefined = not yet detected

/** Probe a TCP port on the given host. Resolves true if a server is listening. */
function probePort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { resolve(false); });
  });
}

/**
 * Detect a local proxy by probing common ports on localhost and Docker host.
 * Called once at startup, result is cached.
 */
async function detectLocalProxy(): Promise<string | null> {
  for (const host of PROXY_HOSTS) {
    for (const { port, proto } of PROXY_PORTS) {
      if (await probePort(host, port)) {
        const url = `${proto}://${host}:${port}`;
        console.log(`[Proxy] Auto-detected local proxy: ${url}`);
        return url;
      }
    }
  }
  return null;
}

/**
 * Initialize proxy detection. Called once at startup from index.ts.
 * Priority: config proxy_url > HTTPS_PROXY env > auto-detect local ports.
 */
export async function initProxy(): Promise<void> {
  const config = getConfig();
  if (config.tls.proxy_url) {
    _proxyUrl = config.tls.proxy_url;
    console.log(`[Proxy] Using configured proxy: ${_proxyUrl}`);
    return;
  }
  _proxyUrl = await detectLocalProxy();
  if (!_proxyUrl) {
    console.log("[Proxy] No local proxy detected — direct connection");
  }
}

/**
 * Get proxy args to prepend to curl commands.
 * Uses cached result from initProxy().
 */
export function getProxyArgs(): string[] {
  if (_proxyUrl) return ["-x", _proxyUrl];
  return [];
}

/**
 * Check if the resolved curl binary is curl-impersonate.
 * When true, it supports br/zstd decompression natively.
 */
export function isImpersonate(): boolean {
  resolveCurlBinary(); // ensure resolved
  return _isImpersonate;
}

/**
 * Get the resolved impersonate profile (e.g. "chrome136").
 * Used by FFI transport which needs the profile name directly.
 */
export function getResolvedProfile(): string {
  getChromeTlsArgs(); // ensure detection has run
  return _resolvedProfile;
}

/**
 * Get the detected proxy URL (or null if no proxy).
 * Used by LibcurlFfiTransport which needs the URL directly (not CLI args).
 */
export function getProxyUrl(): string | null {
  return _proxyUrl ?? null;
}

/**
 * Get curl diagnostic info for /debug/diagnostics endpoint.
 */
export function getCurlDiagnostics(): {
  binary: string | null;
  is_impersonate: boolean;
  profile: string;
  proxy_url: string | null;
} {
  return {
    binary: _resolved,
    is_impersonate: _isImpersonate,
    profile: _resolvedProfile,
    proxy_url: _proxyUrl ?? null,
  };
}

/**
 * Reset the cached binary path (useful for testing).
 */
export function resetCurlBinaryCache(): void {
  _resolved = null;
  _isImpersonate = false;
  _tlsArgs = null;
  _resolvedProfile = "chrome136";
}
