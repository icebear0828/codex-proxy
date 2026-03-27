/**
 * LibcurlFfiTransport — TLS transport using koffi FFI to libcurl-impersonate.
 *
 * Loads libcurl-impersonate shared library (DLL on Windows, .so/.dylib on others)
 * and calls the C API directly. Uses curl_multi for non-blocking streaming.
 *
 * This provides Chrome TLS fingerprint on Windows where the curl-impersonate
 * CLI binary is not available.
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type { IKoffiLib, IKoffiCType, IKoffiRegisteredCallback, KoffiFunction } from "koffi";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getConfig } from "../config.js";
import { getProxyUrl, getResolvedProfile, checkHttp2Fallback, isHttp11Fallback } from "./curl-binary.js";
import { getBinDir } from "../paths.js";

// ── libcurl constants ──────────────────────────────────────────────

const CURLOPT_URL = 10002;
const CURLOPT_HTTPHEADER = 10023;
const CURLOPT_POSTFIELDS = 10015;
const CURLOPT_POSTFIELDSIZE = 60;
const CURLOPT_WRITEFUNCTION = 20011;
const CURLOPT_HEADERFUNCTION = 20079;
const CURLOPT_POST = 47;
const CURLOPT_NOSIGNAL = 99;
const CURLOPT_TIMEOUT = 13;
const CURLOPT_PROXY = 10004;
const CURLOPT_CAINFO = 10065;
const CURLOPT_ACCEPT_ENCODING = 10102;
const CURLOPT_HTTP_VERSION = 84;
const CURL_HTTP_VERSION_1_1 = 2;
const CURL_HTTP_VERSION_2_0 = 3;
const CURLINFO_RESPONSE_CODE = 0x200002;
const CURLM_OK = 0;
const CURLOPT_SHARE = 10100;
const CURLSHOPT_SHARE = 1;
const CURL_LOCK_DATA_SSL_SESSION = 2;
const CURL_LOCK_DATA_CONNECT = 5;
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;

function getHeaderTimeoutMs(): number {
  try {
    return getConfig().api.timeout_seconds * 1000;
  } catch {
    return DEFAULT_HEADER_TIMEOUT_MS;
  }
}

// ── Branded opaque handle types ──────────────────────────────────

/** Opaque C pointer returned by curl_easy_init(). */
type CurlHandle = { readonly __brand: "CURL" };
/** Opaque C pointer returned by curl_multi_init(). */
type CurlMultiHandle = { readonly __brand: "CURLM" };
/** Opaque C pointer for curl_slist linked list. */
type SlistHandle = { readonly __brand: "curl_slist" } | null;
/** Opaque C pointer returned by curl_share_init(). */
type CurlShareHandle = { readonly __brand: "CURLSH" };

/** koffi module loaded via dynamic import (same shape as `typeof import("koffi")`). */
type KoffiModule = typeof import("koffi");

// ── CurlBindings: strongly typed FFI function signatures ─────────

interface CurlBindings {
  koffi: KoffiModule;
  lib: IKoffiLib;
  writeCallbackType: IKoffiCType;
  headerCallbackType: IKoffiCType;
  caPath: string | null;

  curl_easy_init: KoffiFunction;
  curl_easy_cleanup: KoffiFunction;
  curl_easy_setopt_long: KoffiFunction;
  curl_easy_setopt_str: KoffiFunction;
  curl_easy_setopt_ptr: KoffiFunction;
  curl_easy_setopt_share: KoffiFunction;
  curl_easy_setopt_cb: KoffiFunction;
  curl_easy_setopt_header_cb: KoffiFunction;
  curl_easy_getinfo_long: KoffiFunction;
  curl_easy_impersonate: KoffiFunction;
  curl_easy_perform: KoffiFunction;
  curl_slist_append: KoffiFunction;
  curl_slist_free_all: KoffiFunction;
  curl_multi_init: KoffiFunction;
  curl_multi_add_handle: KoffiFunction;
  curl_multi_remove_handle: KoffiFunction;
  curl_multi_perform: KoffiFunction;
  curl_multi_poll: KoffiFunction;
  curl_multi_cleanup: KoffiFunction;
  curl_share_init: KoffiFunction;
  curl_share_setopt_long: KoffiFunction;
  curl_share_cleanup: KoffiFunction;
  shareHandle: CurlShareHandle;
}

/** Promisify a koffi KoffiFunction.async() call (callback as last arg). */
function asyncCall(fn: KoffiFunction, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err: unknown, result: number) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

// ── FFI initialization ─────────────────────────────────────────────

function resolveLibPath(): string | null {
  const binDir = getBinDir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    // lexiforest/curl-impersonate ships the Windows DLL as libcurl.dll
    candidates.push(resolve(binDir, "libcurl.dll"));
  } else if (process.platform === "darwin") {
    candidates.push(resolve(binDir, "libcurl-impersonate.dylib"));
  } else {
    candidates.push(resolve(binDir, "libcurl-impersonate.so"));
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveCaPath(): string | null {
  const candidate = resolve(getBinDir(), "cacert.pem");
  return existsSync(candidate) ? candidate : null;
}

async function initBindings(): Promise<CurlBindings> {
  let koffi: KoffiModule;
  try {
    const mod = await import("koffi");
    koffi = mod.default ?? mod;
  } catch {
    throw new Error("koffi package not installed. Run: npm/pnpm/bun install koffi");
  }

  const dllPath = resolveLibPath();
  if (!dllPath) {
    throw new Error(
      "libcurl-impersonate shared library not found. Run: npm/pnpm/bun run setup",
    );
  }

  const lib: IKoffiLib = koffi.load(dllPath);

  // Define opaque pointer types (referenced by string name in signatures)
  koffi.pointer("CURL", koffi.opaque());
  koffi.pointer("CURLM", koffi.opaque());
  koffi.pointer("CURLSH", koffi.opaque());
  koffi.pointer("curl_slist", koffi.opaque());

  // Callback prototypes
  const writeCallbackType: IKoffiCType = koffi.proto("size_t write_cb(const uint8_t *ptr, size_t size, size_t nmemb, intptr_t userdata)");
  const headerCallbackType: IKoffiCType = koffi.proto("size_t header_cb(const uint8_t *ptr, size_t size, size_t nmemb, intptr_t userdata)");

  // On macOS/Linux, the dylib is built from a static .a with hidden visibility.
  // A C wrapper provides exported symbols with typed signatures (w_curl_* prefix).
  // On Windows, the DLL exports original variadic curl_* symbols directly.
  const useWrapper = process.platform !== "win32";

  // Bind functions — use string names for pointer types (not template literals)
  let curl_global_init: KoffiFunction;
  let curl_easy_init: KoffiFunction;
  let curl_easy_cleanup: KoffiFunction;
  let curl_easy_setopt_long: KoffiFunction;
  let curl_easy_setopt_str: KoffiFunction;
  let curl_easy_setopt_ptr: KoffiFunction;
  let curl_easy_setopt_share: KoffiFunction;
  let curl_easy_setopt_cb: KoffiFunction;
  let curl_easy_setopt_header_cb: KoffiFunction;
  let curl_easy_getinfo_long: KoffiFunction;
  let curl_easy_impersonate: KoffiFunction;
  let curl_easy_perform: KoffiFunction;
  let curl_slist_append: KoffiFunction;
  let curl_slist_free_all: KoffiFunction;
  let curl_multi_init: KoffiFunction;
  let curl_multi_add_handle: KoffiFunction;
  let curl_multi_remove_handle: KoffiFunction;
  let curl_multi_perform: KoffiFunction;
  let curl_multi_poll: KoffiFunction;
  let curl_multi_cleanup: KoffiFunction;
  let curl_share_init: KoffiFunction;
  let curl_share_setopt_long: KoffiFunction;
  let curl_share_cleanup: KoffiFunction;

  if (useWrapper) {
    // Wrapper functions with typed signatures (non-variadic)
    curl_global_init = lib.func("int w_curl_global_init(int flags)");
    curl_easy_init = lib.func("CURL *w_curl_easy_init()");
    curl_easy_cleanup = lib.func("void w_curl_easy_cleanup(CURL *handle)");
    curl_easy_setopt_long = lib.func("int w_curl_easy_setopt_long(CURL *handle, int option, long value)");
    curl_easy_setopt_str = lib.func("int w_curl_easy_setopt_str(CURL *handle, int option, const char *value)");
    curl_easy_setopt_ptr = lib.func("int w_curl_easy_setopt_ptr(CURL *handle, int option, curl_slist *value)");
    curl_easy_setopt_share = lib.func("int w_curl_easy_setopt_ptr(CURL *handle, int option, CURLSH *value)");
    curl_easy_setopt_cb = lib.func("int w_curl_easy_setopt_cb(CURL *handle, int option, write_cb *value)");
    curl_easy_setopt_header_cb = lib.func("int w_curl_easy_setopt_cb(CURL *handle, int option, header_cb *value)");
    curl_easy_getinfo_long = lib.func("int w_curl_easy_getinfo_long(CURL *handle, int info, _Out_ int *value)");
    curl_easy_impersonate = lib.func("int w_curl_easy_impersonate(CURL *handle, const char *target, int default_headers)");
    curl_easy_perform = lib.func("int w_curl_easy_perform(CURL *handle)");
    curl_slist_append = lib.func("curl_slist *w_curl_slist_append(curl_slist *list, const char *string)");
    curl_slist_free_all = lib.func("void w_curl_slist_free_all(curl_slist *list)");
    curl_multi_init = lib.func("CURLM *w_curl_multi_init()");
    curl_multi_add_handle = lib.func("int w_curl_multi_add_handle(CURLM *multi, CURL *easy)");
    curl_multi_remove_handle = lib.func("int w_curl_multi_remove_handle(CURLM *multi, CURL *easy)");
    curl_multi_perform = lib.func("int w_curl_multi_perform(CURLM *multi, _Out_ int *running_handles)");
    curl_multi_poll = lib.func("int w_curl_multi_poll(CURLM *multi, void *extra_fds, int extra_nfds, int timeout_ms, _Out_ int *numfds)");
    curl_multi_cleanup = lib.func("int w_curl_multi_cleanup(CURLM *multi)");
    curl_share_init = lib.func("CURLSH *w_curl_share_init()");
    curl_share_setopt_long = lib.func("int w_curl_share_setopt_long(CURLSH *share, int option, long value)");
    curl_share_cleanup = lib.func("int w_curl_share_cleanup(CURLSH *share)");
  } else {
    // Windows: bind original variadic curl_* symbols
    curl_global_init = lib.func("int curl_global_init(int flags)");
    curl_easy_init = lib.func("CURL *curl_easy_init()");
    curl_easy_cleanup = lib.func("void curl_easy_cleanup(CURL *handle)");
    curl_easy_setopt_long = lib.func("int curl_easy_setopt(CURL *handle, int option, long value)");
    curl_easy_setopt_str = lib.func("int curl_easy_setopt(CURL *handle, int option, const char *value)");
    curl_easy_setopt_ptr = lib.func("int curl_easy_setopt(CURL *handle, int option, curl_slist *value)");
    curl_easy_setopt_share = lib.func("int curl_easy_setopt(CURL *handle, int option, CURLSH *value)");
    curl_easy_setopt_cb = lib.func("int curl_easy_setopt(CURL *handle, int option, write_cb *value)");
    curl_easy_setopt_header_cb = lib.func("int curl_easy_setopt(CURL *handle, int option, header_cb *value)");
    curl_easy_getinfo_long = lib.func("int curl_easy_getinfo(CURL *handle, int info, _Out_ int *value)");
    curl_easy_impersonate = lib.func("int curl_easy_impersonate(CURL *handle, const char *target, int default_headers)");
    curl_easy_perform = lib.func("int curl_easy_perform(CURL *handle)");
    curl_slist_append = lib.func("curl_slist *curl_slist_append(curl_slist *list, const char *string)");
    curl_slist_free_all = lib.func("void curl_slist_free_all(curl_slist *list)");
    curl_multi_init = lib.func("CURLM *curl_multi_init()");
    curl_multi_add_handle = lib.func("int curl_multi_add_handle(CURLM *multi, CURL *easy)");
    curl_multi_remove_handle = lib.func("int curl_multi_remove_handle(CURLM *multi, CURL *easy)");
    curl_multi_perform = lib.func("int curl_multi_perform(CURLM *multi, _Out_ int *running_handles)");
    curl_multi_poll = lib.func("int curl_multi_poll(CURLM *multi, void *extra_fds, int extra_nfds, int timeout_ms, _Out_ int *numfds)");
    curl_multi_cleanup = lib.func("int curl_multi_cleanup(CURLM *multi)");
    curl_share_init = lib.func("CURLSH *curl_share_init()");
    curl_share_setopt_long = lib.func("int curl_share_setopt(CURLSH *share, int option, long value)");
    curl_share_cleanup = lib.func("int curl_share_cleanup(CURLSH *share)");
  }

  // Global init (CURL_GLOBAL_DEFAULT = 3)
  curl_global_init(3);

  const caPath = resolveCaPath();
  if (caPath) {
    console.log(`[TLS/FFI] Using CA bundle: ${caPath}`);
  } else {
    console.warn("[TLS/FFI] No CA bundle at bin/cacert.pem — HTTPS may fail");
  }

  // Create shared handle for connection + SSL session reuse across requests
  const shareHandle = curl_share_init() as CurlShareHandle;
  if (!shareHandle) throw new Error("curl_share_init() returned null");
  curl_share_setopt_long(shareHandle, CURLSHOPT_SHARE, CURL_LOCK_DATA_CONNECT);
  curl_share_setopt_long(shareHandle, CURLSHOPT_SHARE, CURL_LOCK_DATA_SSL_SESSION);
  console.log("[TLS/FFI] Connection pool enabled (CURLSH: connect + ssl_session)");

  return {
    koffi,
    lib,
    writeCallbackType,
    headerCallbackType,
    caPath,
    curl_easy_init,
    curl_easy_cleanup,
    curl_easy_setopt_long,
    curl_easy_setopt_str,
    curl_easy_setopt_ptr,
    curl_easy_setopt_share,
    curl_easy_setopt_cb,
    curl_easy_setopt_header_cb,
    curl_easy_getinfo_long,
    curl_easy_impersonate,
    curl_easy_perform,
    curl_slist_append,
    curl_slist_free_all,
    curl_multi_init,
    curl_multi_add_handle,
    curl_multi_remove_handle,
    curl_multi_perform,
    curl_multi_poll,
    curl_multi_cleanup,
    curl_share_init,
    curl_share_setopt_long,
    curl_share_cleanup,
    shareHandle,
  };
}

// ── Transport implementation ───────────────────────────────────────

export class LibcurlFfiTransport implements TlsTransport {
  private b: CurlBindings;

  constructor(bindings: CurlBindings) {
    this.b = bindings;
  }

  /**
   * Streaming POST using curl_multi event loop.
   * Data arrives via WRITEFUNCTION callback → pushed into ReadableStream.
   */
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }

      const { easy, slist } = this.setupEasyHandle(url, headers, {
        method: "POST",
        body,
        timeoutSec,
        proxyUrl,
      });

      const b = this.b;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let headersParsed = false;
      let statusCode = 0;
      const responseHeaders = new Headers();
      const setCookieHeaders: string[] = [];

      // Register persistent WRITEFUNCTION callback
      const writeCallback: IKoffiRegisteredCallback = b.koffi.register(
        (ptr: unknown, size: number, nmemb: number, _userdata: unknown): number => {
          const totalBytes = size * nmemb;
          if (totalBytes === 0) return 0;
          const arr = b.koffi.decode(ptr, "uint8_t", totalBytes) as number[];
          const chunk = new Uint8Array(arr);
          bodyController?.enqueue(chunk);
          return totalBytes;
        },
        b.koffi.pointer(b.writeCallbackType),
      );

      // Register HEADERFUNCTION callback to capture response headers
      const headerCallback: IKoffiRegisteredCallback = b.koffi.register(
        (ptr: unknown, size: number, nmemb: number, _userdata: unknown): number => {
          const totalBytes = size * nmemb;
          if (totalBytes === 0) return 0;
          const arr = b.koffi.decode(ptr, "uint8_t", totalBytes) as number[];
          const line = Buffer.from(arr).toString("utf-8");

          const statusMatch = line.match(/^HTTP\/[\d.]+ (\d+)/);
          if (statusMatch) {
            statusCode = parseInt(statusMatch[1], 10);
            return totalBytes;
          }

          const colonIdx = line.indexOf(":");
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (key.toLowerCase() === "set-cookie") {
              setCookieHeaders.push(value);
            }
            responseHeaders.append(key, value);
          }

          return totalBytes;
        },
        b.koffi.pointer(b.headerCallbackType),
      );

      b.curl_easy_setopt_cb(easy, CURLOPT_WRITEFUNCTION, writeCallback);
      b.curl_easy_setopt_header_cb(easy, CURLOPT_HEADERFUNCTION, headerCallback);

      // Create ReadableStream for the body
      let aborted = false;
      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) {
          bodyController = c;
        },
        cancel() {
          aborted = true;
        },
      });

      const onAbort = () => {
        aborted = true;
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Use curl_multi for non-blocking operation
      const multi = b.curl_multi_init() as CurlMultiHandle;
      b.curl_multi_add_handle(multi, easy);

      const runningHandles = new Int32Array(1);
      const numfds = new Int32Array(1);
      let resolved = false;

      const cleanup = () => {
        b.curl_multi_remove_handle(multi, easy);
        b.curl_multi_cleanup(multi);
        b.curl_easy_cleanup(easy);
        if (slist) b.curl_slist_free_all(slist);
        b.koffi.unregister(writeCallback);
        b.koffi.unregister(headerCallback);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const pollLoop = async () => {
        try {
          while (!aborted) {
            const pollResult = await asyncCall(b.curl_multi_poll, multi, null, 0, 100, numfds);
            if (pollResult !== CURLM_OK) break;

            const performResult = await asyncCall(b.curl_multi_perform, multi, runningHandles);
            if (performResult !== CURLM_OK) break;

            // After headers are received, resolve the promise
            if (!resolved && statusCode > 0) {
              resolved = true;
              headersParsed = true;
              resolve({
                status: statusCode,
                headers: responseHeaders,
                body: bodyStream,
                setCookieHeaders,
              });
            }

            if (runningHandles[0] === 0) break;
          }
        } catch (err) {
          if (!resolved) {
            const msg = err instanceof Error ? err.message : String(err);
            checkHttp2Fallback(msg, null);
            reject(err instanceof Error ? err : new Error(msg));
          }
        } finally {
          cleanup();
          bodyController?.close();

          if (!resolved) {
            reject(new Error("curl: transfer completed without receiving headers"));
          }
        }
      };

      // Header timeout
      const headerTimer = setTimeout(() => {
        if (!headersParsed) {
          aborted = true;
          if (!resolved) {
            reject(new Error(`curl header parse timeout after ${getHeaderTimeoutMs()}ms`));
          }
        }
      }, getHeaderTimeoutMs());
      if (headerTimer.unref) headerTimer.unref();

      pollLoop().finally(() => clearTimeout(headerTimer));
    });
  }

  async get(
    url: string,
    headers: Record<string, string>,
    timeoutSec = 30,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    return this.simpleRequest(url, headers, undefined, timeoutSec, proxyUrl);
  }

  async simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec = 30,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    return this.simpleRequest(url, headers, body, timeoutSec, proxyUrl);
  }

  isImpersonate(): boolean {
    return true;
  }

  destroy(): void {
    this.b.curl_share_cleanup(this.b.shareHandle);
  }

  private async simpleRequest(
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutSec: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const b = this.b;
    const { easy, slist } = this.setupEasyHandle(url, headers, {
      method: body !== undefined ? "POST" : "GET",
      body,
      timeoutSec,
      proxyUrl,
    });

    const chunks: Buffer[] = [];

    const writeCallback: IKoffiRegisteredCallback = b.koffi.register(
      (ptr: unknown, size: number, nmemb: number, _userdata: unknown): number => {
        const totalBytes = size * nmemb;
        if (totalBytes === 0) return 0;
        const arr = b.koffi.decode(ptr, "uint8_t", totalBytes) as number[];
        chunks.push(Buffer.from(arr));
        return totalBytes;
      },
      b.koffi.pointer(b.writeCallbackType),
    );

    b.curl_easy_setopt_cb(easy, CURLOPT_WRITEFUNCTION, writeCallback);

    try {
      const result = await asyncCall(b.curl_easy_perform, easy);
      if (result !== 0) {
        // result is CURLcode — 16 = HTTP2 error, check for fallback
        checkHttp2Fallback("", result);
        throw new Error(`curl_easy_perform failed with code ${result}`);
      }

      const statusBuf = new Int32Array(1);
      b.curl_easy_getinfo_long(easy, CURLINFO_RESPONSE_CODE, statusBuf);
      const status = statusBuf[0];

      const responseBody = Buffer.concat(chunks).toString("utf-8");
      return { status, body: responseBody };
    } finally {
      b.curl_easy_cleanup(easy);
      if (slist) b.curl_slist_free_all(slist);
      b.koffi.unregister(writeCallback);
    }
  }

  /** Setup a curl easy handle with common options. */
  private setupEasyHandle(
    url: string,
    headers: Record<string, string>,
    opts: {
      method?: "GET" | "POST";
      body?: string;
      timeoutSec?: number;
      proxyUrl?: string | null;
    } = {},
  ): { easy: CurlHandle; slist: SlistHandle } {
    const b = this.b;
    const easy = b.curl_easy_init() as CurlHandle;
    if (!easy) throw new Error("curl_easy_init() returned null");

    // Impersonate Chrome — 0 = don't inject default headers (we control them)
    b.curl_easy_impersonate(easy, getResolvedProfile(), 0);

    // Attach shared connection pool for TCP + TLS session reuse
    b.curl_easy_setopt_share(easy, CURLOPT_SHARE, b.shareHandle);

    b.curl_easy_setopt_str(easy, CURLOPT_URL, url);
    b.curl_easy_setopt_long(easy, CURLOPT_NOSIGNAL, 1);

    // HTTP version: use HTTP/1.1 when configured or auto-fallback active
    const config = getConfig();
    const httpVersion = (config.tls.force_http11 || isHttp11Fallback()) ? CURL_HTTP_VERSION_1_1 : CURL_HTTP_VERSION_2_0;
    b.curl_easy_setopt_long(easy, CURLOPT_HTTP_VERSION, httpVersion);

    // Accept-Encoding — let libcurl handle decompression
    b.curl_easy_setopt_str(easy, CURLOPT_ACCEPT_ENCODING, "");

    // CA bundle for BoringSSL (not using system cert store)
    if (b.caPath) {
      b.curl_easy_setopt_str(easy, CURLOPT_CAINFO, b.caPath);
    }

    if (opts.timeoutSec) {
      b.curl_easy_setopt_long(easy, CURLOPT_TIMEOUT, opts.timeoutSec);
    }

    // Proxy: per-request override > global default
    // null = direct (no proxy), undefined = use global, string = specific proxy
    const effectiveProxy = opts.proxyUrl === null ? null : (opts.proxyUrl ?? getProxyUrl());
    if (effectiveProxy) {
      b.curl_easy_setopt_str(easy, CURLOPT_PROXY, effectiveProxy);
    }

    // Headers — build slist
    let slist: SlistHandle = null;
    for (const [key, value] of Object.entries(headers)) {
      slist = b.curl_slist_append(slist, `${key}: ${value}`) as SlistHandle;
    }
    slist = b.curl_slist_append(slist, "Expect:") as SlistHandle;
    if (slist) {
      b.curl_easy_setopt_ptr(easy, CURLOPT_HTTPHEADER, slist);
    }

    // POST body
    if (opts.method === "POST" || opts.body !== undefined) {
      const postBody = opts.body ?? "";
      b.curl_easy_setopt_long(easy, CURLOPT_POST, 1);
      b.curl_easy_setopt_str(easy, CURLOPT_POSTFIELDS, postBody);
      b.curl_easy_setopt_long(easy, CURLOPT_POSTFIELDSIZE, Buffer.byteLength(postBody, "utf-8"));
    }

    return { easy, slist };
  }
}

/**
 * Async factory — loads koffi + libcurl-impersonate and returns a transport instance.
 */
export async function createLibcurlFfiTransport(): Promise<LibcurlFfiTransport> {
  const bindings = await initBindings();
  return new LibcurlFfiTransport(bindings);
}
