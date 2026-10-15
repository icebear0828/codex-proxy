import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { getConfig } from "../config.js";
import { getProxyUrl } from "../tls/proxy.js";

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

let cachedGlobalProxyUrl: string | null = null;
let cachedGlobalNoProxy: string | null = null;
let cachedGlobalDispatcher: Dispatcher | undefined;

const customDispatcherCache = new Map<string, Dispatcher>();

export function resolveNoProxy(): string {
  const envNoProxy = process.env.NO_PROXY || process.env.no_proxy;
  return envNoProxy ? `${DEFAULT_NO_PROXY},${envNoProxy}` : DEFAULT_NO_PROXY;
}

export function getGlobalProxyUrl(): string | null {
  try {
    return (
      getConfig().tls.proxy_url ||
      getProxyUrl() ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      null
    );
  } catch {
    return (
      getProxyUrl() ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      null
    );
  }
}

/**
 * Get a Dispatcher for the specified proxy URL.
 * - `targetProxyUrl === null`: Direct connection requested; returns `undefined` (no dispatcher).
 * - `typeof targetProxyUrl === "string"`: Use the specific proxy URL with loopback bypass.
 * - `targetProxyUrl === undefined`: Use the global proxy URL.
 */
export function getFetchDispatcher(targetProxyUrl?: string | null): Dispatcher | undefined {
  if (targetProxyUrl === null) {
    return undefined;
  }

  const noProxy = resolveNoProxy();
  const effectiveProxyUrl = targetProxyUrl !== undefined ? targetProxyUrl : getGlobalProxyUrl();
  if (!effectiveProxyUrl) return undefined;

  if (targetProxyUrl === undefined) {
    if (
      effectiveProxyUrl === cachedGlobalProxyUrl &&
      noProxy === cachedGlobalNoProxy &&
      cachedGlobalDispatcher
    ) {
      return cachedGlobalDispatcher;
    }
    cachedGlobalProxyUrl = effectiveProxyUrl;
    cachedGlobalNoProxy = noProxy;
    cachedGlobalDispatcher = new EnvHttpProxyAgent({
      httpProxy: effectiveProxyUrl,
      httpsProxy: effectiveProxyUrl,
      noProxy,
    });
    return cachedGlobalDispatcher;
  }

  const cacheKey = `${effectiveProxyUrl}::${noProxy}`;
  let dispatcher = customDispatcherCache.get(cacheKey);
  if (!dispatcher) {
    dispatcher = new EnvHttpProxyAgent({
      httpProxy: effectiveProxyUrl,
      httpsProxy: effectiveProxyUrl,
      noProxy,
    });
    customDispatcherCache.set(cacheKey, dispatcher);
  }
  return dispatcher;
}

export function withFetchDispatcher(
  init: RequestInit,
  dispatcherOrProxyUrl?: Dispatcher | string | null,
): RequestInit & { dispatcher?: Dispatcher } {
  const dispatcher =
    dispatcherOrProxyUrl && typeof dispatcherOrProxyUrl === "object" && "dispatch" in dispatcherOrProxyUrl
      ? (dispatcherOrProxyUrl as Dispatcher)
      : getFetchDispatcher(dispatcherOrProxyUrl as string | null | undefined);
  return dispatcher ? { ...init, dispatcher } : init;
}

