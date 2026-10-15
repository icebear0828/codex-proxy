import type { ApiKeyPool } from "../auth/api-key-pool.js";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import { createAdapterForEntry } from "./adapter-factory.js";
import { UpstreamRouter, type AdapterFactory } from "./upstream-router.js";
import type { ProxyPool } from "./proxy-pool.js";

export function createRuntimeUpstreamRouter(
  adapters: Map<string, UpstreamAdapter>,
  modelRouting: Record<string, string>,
  apiKeyPool: ApiKeyPool,
  adapterFactoryOrProxyPool?: AdapterFactory | ProxyPool,
  proxyPool?: ProxyPool,
): UpstreamRouter {
  let factory: AdapterFactory;
  let pool: ProxyPool | undefined;

  if (typeof adapterFactoryOrProxyPool === "function") {
    factory = adapterFactoryOrProxyPool;
    pool = proxyPool;
  } else {
    pool = adapterFactoryOrProxyPool ?? proxyPool;
    factory = (entry) => createAdapterForEntry(entry, pool);
  }

  const router = new UpstreamRouter(adapters, modelRouting, "codex");
  router.setApiKeyPool(apiKeyPool, factory);
  return router;
}

