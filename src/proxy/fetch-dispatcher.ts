import { ProxyAgent, type Dispatcher } from "undici";
import { getConfig } from "../config.js";

let cachedProxyUrl: string | null = null;
let cachedDispatcher: Dispatcher | undefined;

export function getFetchDispatcher(): Dispatcher | undefined {
  let proxyUrl: string | null = null;
  try {
    proxyUrl = getConfig().tls.proxy_url;
  } catch {
    proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  }

  if (!proxyUrl) return undefined;
  if (proxyUrl === cachedProxyUrl && cachedDispatcher) return cachedDispatcher;

  cachedProxyUrl = proxyUrl;
  cachedDispatcher = new ProxyAgent(proxyUrl);
  return cachedDispatcher;
}

export function withFetchDispatcher(init: RequestInit): RequestInit & { dispatcher?: Dispatcher } {
  const dispatcher = getFetchDispatcher();
  return dispatcher ? { ...init, dispatcher } : init;
}
