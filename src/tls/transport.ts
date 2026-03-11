/**
 * TLS Transport abstraction — decouples upstream request logic from
 * the concrete transport (curl CLI subprocess vs libcurl FFI).
 *
 * Singleton: call initTransport() once at startup, then getTransport() anywhere.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { getBinDir } from "../paths.js";

export interface TlsTransportResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  setCookieHeaders: string[];
}

export interface TlsTransport {
  /**
   * Streaming POST (for SSE). Returns headers + streaming body.
   * @param proxyUrl  undefined = global default, null = direct (no proxy), string = specific proxy
   */
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse>;

  /**
   * Simple GET — returns full body as string.
   * @param proxyUrl  undefined = global default, null = direct (no proxy), string = specific proxy
   */
  get(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }>;

  /**
   * Simple (non-streaming) POST — returns full body as string.
   * @param proxyUrl  undefined = global default, null = direct (no proxy), string = specific proxy
   */
  simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }>;

  /** Whether this transport provides a Chrome TLS fingerprint. */
  isImpersonate(): boolean;
}

let _transport: TlsTransport | null = null;
let _transportType: "libcurl-ffi" | "curl-cli" | "none" = "none";
let _ffiError: string | null = null;

/**
 * Initialize the transport singleton. Must be called once at startup
 * after config and proxy detection are ready.
 */
export async function initTransport(): Promise<TlsTransport> {
  if (_transport) return _transport;

  const { getConfig } = await import("../config.js");
  const config = getConfig();
  const setting = config.tls.transport ?? "auto";

  if (setting === "libcurl-ffi" || (setting === "auto" && shouldUseFfi())) {
    try {
      const { createLibcurlFfiTransport } = await import("./libcurl-ffi-transport.js");
      _transport = await createLibcurlFfiTransport();
      _transportType = "libcurl-ffi";
      console.log("[TLS] Using libcurl-impersonate FFI transport");
      return _transport;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (setting === "libcurl-ffi") {
        throw new Error(`Failed to initialize libcurl FFI transport: ${msg}`);
      }
      _ffiError = msg;
      console.warn(`[TLS] FFI transport unavailable (${msg}), falling back to curl CLI`);
    }
  }

  const { CurlCliTransport } = await import("./curl-cli-transport.js");
  _transport = new CurlCliTransport();
  _transportType = "curl-cli";
  console.log("[TLS] Using curl CLI transport");
  return _transport;
}

/**
 * Get the initialized transport. Throws if initTransport() hasn't been called.
 */
export function getTransport(): TlsTransport {
  if (!_transport) throw new Error("Transport not initialized. Call initTransport() first.");
  return _transport;
}

/**
 * Determine if FFI transport should be used in "auto" mode.
 * FFI is preferred on Windows where curl-impersonate CLI is unavailable.
 */
function shouldUseFfi(): boolean {
  if (process.platform !== "win32") return false;

  // Check if libcurl-impersonate DLL exists (shipped as libcurl.dll)
  const dllPath = resolve(getBinDir(), "libcurl.dll");
  return existsSync(dllPath);
}

/** Get transport diagnostic info. */
export function getTransportInfo(): {
  type: "libcurl-ffi" | "curl-cli" | "none";
  initialized: boolean;
  impersonate: boolean;
  ffi_error: string | null;
} {
  return {
    type: _transportType,
    initialized: _transport !== null,
    impersonate: _transport?.isImpersonate() ?? false,
    ffi_error: _ffiError,
  };
}

/** Reset transport singleton (for testing). */
export function resetTransport(): void {
  _transport = null;
  _transportType = "none";
  _ffiError = null;
}
