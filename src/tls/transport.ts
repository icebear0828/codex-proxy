/**
 * TLS Transport abstraction — decouples upstream request logic from
 * the concrete transport implementation.
 *
 * Singleton: call initTransport() once at startup, then getTransport() anywhere.
 */

import { isNativeAvailable } from "./native-transport.js";

export interface TlsTransportResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  setCookieHeaders: string[];
}

export interface TlsTransport {
  /** Clean up transport resources (connection pools, shared handles). */
  destroy?(): void;
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

  /** GET with Set-Cookie header capture. Used by warmup for session cookie establishment. */
  getWithCookies?(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }>;

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
let _transportType: "native" | "none" = "none";

/**
 * Initialize the transport singleton. Must be called once at startup
 * after config and proxy detection are ready.
 */
export async function initTransport(): Promise<TlsTransport> {
  if (_transport) return _transport;

  if (!isNativeAvailable()) {
    throw new Error(
      "Native transport addon not found. Ensure native/codex-tls.*.node is present.",
    );
  }

  const { createNativeTransport } = await import("./native-transport.js");
  _transport = await createNativeTransport();
  _transportType = "native";
  console.log("[TLS] Using native (rustls) transport");
  return _transport;
}

/**
 * Get the initialized transport. Throws if initTransport() hasn't been called.
 */
export function getTransport(): TlsTransport {
  if (!_transport) throw new Error("Transport not initialized. Call initTransport() first.");
  return _transport;
}

/** Get transport diagnostic info. */
export function getTransportInfo(): {
  type: "native" | "none";
  initialized: boolean;
  impersonate: boolean;
} {
  return {
    type: _transportType,
    initialized: _transport !== null,
    impersonate: _transport?.isImpersonate() ?? false,
  };
}

/** Reset transport singleton (for testing). */
export function resetTransport(): void {
  _transport = null;
  _transportType = "none";
}
