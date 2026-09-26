/**
 * Native transport — uses a Rust addon (reqwest + rustls) for HTTP requests.
 *
 * TLS fingerprint matches the real Codex Desktop (codex-rs binary) exactly:
 * reqwest 0.12.28 + hyper-rustls 0.27.7 + rustls 0.23.36.
 *
 * This avoids the Chrome TLS / Codex Desktop UA mismatch that
 * curl-impersonate introduced.
 */

import { resolve } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getProxyUrl } from "./proxy.js";
import { getConfig } from "../config.js";
import { getBinDir } from "../paths.js";

interface NativeGetResponse {
  status: number;
  body: string;
  setCookieHeaders: string[];
}

interface NativePostResponse {
  status: number;
  body: string;
}

interface NativeStreamMeta {
  status: number;
  headers: Record<string, string>;
  setCookieHeaders: string[];
}

interface NativeBindings {
  httpGet(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
  ): Promise<NativeGetResponse>;
  httpPost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
  ): Promise<NativePostResponse>;
  httpPostStream(
    url: string,
    headers: Record<string, string>,
    body: string,
    onChunk: (chunk: Buffer | null | undefined) => void,
    proxyUrl?: string | null,
    forceHttp11?: boolean | null,
    requestId?: string | null,
  ): Promise<NativeStreamMeta>;
  /** Present only on addons built with the cancellation registry. */
  httpCancel?(requestId: string): boolean;
}

/** Resolve the effective proxy URL for a request. */
function resolveProxy(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl === null) return null; // explicit direct
  if (proxyUrl !== undefined) return proxyUrl; // explicit proxy
  return getProxyUrl(); // global default
}

/** Poll cadence for the streaming idle watchdog. */
const IDLE_CHECK_INTERVAL_MS = 1000;

export interface StreamIdleWatchdog {
  /** Record activity (a body byte arrived). */
  onChunk(): void;
  /** Start enforcing; onFire runs once when the idle budget is exceeded. */
  arm(onFire: () => void): void;
  /** Stop polling (stream completed, cancelled, errored, or aborted). */
  dispose(): void;
  /** True once the watchdog fired. */
  fired(): boolean;
}

/**
 * Streaming-body idle watchdog. A half-open connection (NAT expiry, base
 * station handover, silent upstream stall) delivers no bytes and no FIN —
 * without this, an SSE response hangs until the client gives up on its own.
 * Enforcement starts at the FIRST body byte: a long pre-first-token thinking
 * pause is legitimate and must never be cut. Fires by erroring the stream so
 * consumers surface it through the regular premature-close paths.
 */
export function createIdleWatchdog(idleTimeoutMs: number): StreamIdleWatchdog {
  let lastActivityAt = 0; // 0 = body not started — no enforcement yet
  let timer: ReturnType<typeof setInterval> | null = null;
  let didFire = false;

  return {
    onChunk() {
      lastActivityAt = Date.now();
    },
    arm(onFire) {
      if (idleTimeoutMs <= 0) return;
      timer = setInterval(() => {
        if (didFire || lastActivityAt === 0) return;
        if (Date.now() - lastActivityAt < idleTimeoutMs) return;
        didFire = true;
        onFire();
      }, IDLE_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    dispose() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    fired() {
      return didFire;
    },
  };
}

export class NativeTransport implements TlsTransport {
  private bindings: NativeBindings;

  constructor(bindings: NativeBindings) {
    this.bindings = bindings;
  }

  isImpersonate(): boolean {
    return false; // rustls, not Chrome
  }

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    const proxy = resolveProxy(proxyUrl);
    const idleTimeoutMs = getConfig().tls.stream_idle_timeout_ms;

    // Cancellation handle for the Rust side. Older addons have no httpCancel:
    // in that case no id is generated and cancelUpstream is a no-op.
    const cancelable = typeof this.bindings.httpCancel === "function";
    const requestId = cancelable ? randomUUID() : null;
    const cancelUpstream = (): void => {
      if (requestId) {
        try { this.bindings.httpCancel!(requestId); } catch { /* already deregistered */ }
      }
    };

    const watchdog = createIdleWatchdog(idleTimeoutMs);
    let watchdogArmed = false;

    // Set up a ReadableStream that receives chunks from the Rust callback
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        streamController = null;
        cancelUpstream();
        watchdog.dispose();
      },
    });

    const onChunk = (chunk: Buffer | null | undefined): void => {
      if (!streamController) return;
      if (chunk == null) {
        watchdog.dispose();
        try { streamController.close(); } catch { /* already closed */ }
        streamController = null;
      } else {
        // Enforcement starts at the first body byte, not at headers: the gap
        // before the first token is legitimate model thinking time.
        if (!watchdogArmed) {
          watchdogArmed = true;
          watchdog.arm(() => {
            const controller = streamController;
            streamController = null;
            watchdog.dispose();
            cancelUpstream();
            try {
              controller?.error(
                new Error(
                  `Upstream stream idle for ${idleTimeoutMs}ms — treating as disconnected`,
                ),
              );
            } catch { /* already closed or errored */ }
          });
        }
        watchdog.onChunk();
        // Buffer extends Uint8Array — enqueue directly without copying
        try { streamController.enqueue(chunk); } catch { /* closed */ }
      }
    };

    type PostStreamFn = (
      url: string,
      headers: Record<string, string>,
      body: string,
      onChunk: (chunk: Buffer | null | undefined) => void,
      proxyUrl?: string | null,
      forceHttp11?: boolean | null,
      requestId?: string | null,
    ) => Promise<NativeStreamMeta>;
    const postStream = this.bindings.httpPostStream.bind(this.bindings) as PostStreamFn;
    // Pass the 7th arg only when the addon actually supports cancellation:
    // napi-rs wrappers dispatch on argument count, so an old addon must not
    // see an extra trailing undefined.
    const metaPromise = requestId
      ? postStream(url, headers, body, onChunk, proxy, getConfig().tls.force_http11, requestId)
      : postStream(url, headers, body, onChunk, proxy, getConfig().tls.force_http11);
    // If the header timeout (or an abort) wins the race, the Rust side will
    // reject this promise later with "cancelled" — swallow that to avoid an
    // unhandled rejection; the caller already got our error.
    metaPromise.catch(() => {});

    // Pre-header hang: send() resolves no meta until headers arrive. The idle
    // watchdog only guards body bytes, so race the meta promise against the
    // same no-progress budget; on timeout we cancel the upstream send and
    // reject — the adapter surfaces it as a transport failure (retryable).
    let settled = false;
    let headerTimer: ReturnType<typeof setTimeout> | null = null;
    const headerRace: Promise<never> | null =
      idleTimeoutMs > 0
        ? new Promise<never>((_, reject) => {
            headerTimer = setTimeout(() => {
              if (settled) return;
              cancelUpstream();
              reject(
                new Error(
                  `Upstream response headers not received within ${idleTimeoutMs}ms — treating as disconnected`,
                ),
              );
            }, idleTimeoutMs);
            headerTimer.unref?.();
          })
        : null;

    const meta = await (headerRace
      ? Promise.race([metaPromise, headerRace])
      : metaPromise);
    settled = true;
    if (headerTimer) clearTimeout(headerTimer);

    // Handle abort signal
    if (signal) {
      const onAbort = (): void => {
        watchdog.dispose();
        cancelUpstream();
        if (streamController) {
          try { streamController.close(); } catch { /* already closed */ }
          streamController = null;
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Convert flat headers to Web Headers object
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(meta.headers)) {
      // Skip set-cookie from main headers (handled separately)
      if (key.toLowerCase() === "set-cookie") continue;
      responseHeaders.append(key, value);
    }

    return {
      status: meta.status,
      headers: responseHeaders,
      body: readable,
      setCookieHeaders: meta.setCookieHeaders,
    };
  }

  async get(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    const h11 = getConfig().tls.force_http11;
    const result = await this.bindings.httpGet(url, headers, timeoutSec, proxy, h11);
    return { status: result.status, body: result.body };
  }

  async getWithCookies(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpGet(url, headers, timeoutSec, proxy, getConfig().tls.force_http11);
  }

  async simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpPost(url, headers, body, timeoutSec, proxy, getConfig().tls.force_http11);
  }
}

/**
 * Resolve the native addon directory.
 * In Electron (embedded): binDir is resources/bin → sibling native/ dir.
 * In CLI (dev):           binDir is ./bin         → sibling native/ dir.
 */
function getNativeDir(): string {
  return resolve(getBinDir(), "..", "native");
}

/** Check if the native addon is available for the current platform. */
export function isNativeAvailable(): boolean {
  return existsSync(resolve(getNativeDir(), "index.js"));
}

/** Create a NativeTransport instance. Throws if the addon is not available. */
export async function createNativeTransport(): Promise<NativeTransport> {
  const nativeDir = getNativeDir();
  const loaderPath = resolve(nativeDir, "index.js");

  if (!existsSync(loaderPath)) {
    throw new Error(`Native addon not found at ${loaderPath}. Run 'cd native && npm run build' first.`);
  }

  // Dynamic import of the CJS loader generated by napi-rs
  const { createRequire } = await import("module");
  const require = createRequire(loaderPath);
  const bindings = require(loaderPath) as NativeBindings;

  if (!bindings.httpGet || !bindings.httpPost || !bindings.httpPostStream) {
    throw new Error("Native addon loaded but missing expected exports (httpGet, httpPost, httpPostStream)");
  }

  return new NativeTransport(bindings);
}
