/**
 * Simple GET/POST helpers using the TLS transport layer.
 *
 * Drop-in replacement for Node.js fetch() that routes through
 * the native (rustls) transport with Chrome TLS fingerprint.
 *
 * Automatically injects anonymous fingerprint headers.
 * Used for non-streaming requests (OAuth, appcast, etc.).
 */

import { getTransport, type TlsTransport } from "./transport.js";
import { buildAnonymousHeaders } from "../fingerprint/manager.js";

export interface CurlFetchResponse {
  status: number;
  body: string;
  ok: boolean;
}

export interface CurlFetchOptions {
  /** Proxy override: undefined = global default, null = direct, string = specific. */
  proxyUrl?: string | null;
  /** Injected transport (skip singleton). */
  transport?: TlsTransport;
}

/**
 * Perform a GET request via the TLS transport.
 */
export async function curlFetchGet(
  url: string,
  options?: CurlFetchOptions,
): Promise<CurlFetchResponse> {
  const transport = options?.transport ?? getTransport();
  const headers = buildAnonymousHeaders();
  // Let --compressed auto-negotiate Accept-Encoding based on curl's actual
  // decompression capabilities, avoiding error 61 on builds lacking br/zstd.
  delete headers["Accept-Encoding"];

  const result = await transport.get(url, headers, 30, options?.proxyUrl);
  return {
    status: result.status,
    body: result.body,
    ok: result.status >= 200 && result.status < 300,
  };
}

/**
 * Perform a POST request via the TLS transport.
 */
export async function curlFetchPost(
  url: string,
  contentType: string,
  body: string,
  options?: CurlFetchOptions,
): Promise<CurlFetchResponse> {
  const transport = options?.transport ?? getTransport();
  const headers = buildAnonymousHeaders();
  // Let --compressed auto-negotiate Accept-Encoding based on curl's actual
  // decompression capabilities, avoiding error 61 on builds lacking br/zstd.
  delete headers["Accept-Encoding"];
  headers["Content-Type"] = contentType;

  const result = await transport.simplePost(url, headers, body, 30, options?.proxyUrl);
  return {
    status: result.status,
    body: result.body,
    ok: result.status >= 200 && result.status < 300,
  };
}
