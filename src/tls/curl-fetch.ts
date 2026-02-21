/**
 * Simple GET/POST helpers using the TLS transport layer.
 *
 * Drop-in replacement for Node.js fetch() that routes through
 * the active transport (curl CLI or libcurl FFI) with Chrome TLS profile.
 *
 * Automatically injects anonymous fingerprint headers.
 * Used for non-streaming requests (OAuth, appcast, etc.).
 */

import { getTransport } from "./transport.js";
import { buildAnonymousHeaders } from "../fingerprint/manager.js";

export interface CurlFetchResponse {
  status: number;
  body: string;
  ok: boolean;
}

/**
 * Perform a GET request via the TLS transport.
 */
export async function curlFetchGet(url: string): Promise<CurlFetchResponse> {
  const transport = getTransport();
  const headers = buildAnonymousHeaders();

  const result = await transport.get(url, headers, 30);
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
): Promise<CurlFetchResponse> {
  const transport = getTransport();
  const headers = buildAnonymousHeaders();
  headers["Content-Type"] = contentType;

  const result = await transport.simplePost(url, headers, body, 30);
  return {
    status: result.status,
    body: result.body,
    ok: result.status >= 200 && result.status < 300,
  };
}
