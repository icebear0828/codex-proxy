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
import { resolve } from "path";
import { getConfig } from "../config.js";

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
  const binPath = resolve(process.cwd(), "bin", BINARY_NAME);
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
    `Falling back to system curl. Run "npm run setup" to install curl-impersonate.`,
  );
  return _resolved;
}

/**
 * Detect if curl-impersonate supports the --impersonate flag.
 * If supported, returns ["--impersonate", profile] which replaces CHROME_TLS_ARGS.
 * Otherwise returns the manual CHROME_TLS_ARGS.
 */
function detectImpersonateSupport(binary: string): string[] {
  try {
    const helpOutput = execFileSync(binary, ["--help", "all"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (helpOutput.includes("--impersonate")) {
      const profile = getConfig().tls.impersonate_profile ?? "chrome136";
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
 */
export function getChromeTlsArgs(): string[] {
  // Ensure binary is resolved first
  resolveCurlBinary();
  if (!_isImpersonate) return [];
  if (!_tlsArgs) {
    _tlsArgs = detectImpersonateSupport(_resolved!);
  }
  return [..._tlsArgs];
}

/**
 * Reset the cached binary path (useful for testing).
 */
export function resetCurlBinaryCache(): void {
  _resolved = null;
  _isImpersonate = false;
  _tlsArgs = null;
}
