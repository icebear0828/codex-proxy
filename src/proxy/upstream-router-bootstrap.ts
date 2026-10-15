import type { ApiKeyPool } from "../auth/api-key-pool.js";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import { createAdapterForEntry } from "./adapter-factory.js";
import { UpstreamRouter, type AdapterFactory } from "./upstream-router.js";
import type { ProxyPool } from "./proxy-pool.js";

export function createRuntimeUpstreamRouter(
  adapters: Map<string, UpstreamAdapter>,
  modelRouting: Record<string, string>,
  apiKeyPool: ApiKeyPool,
  proxyPool?: ProxyPool,
): UpstreamRouter;
export function createRuntimeUpstreamRouter(
  adapters: Map<string, UpstreamAdapter>,
  modelRouting: Record<string, string>,
  apiKeyPool: ApiKeyPool,
  adapterFactory: AdapterFactory,
  proxyPool?: ProxyPool,
): UpstreamRouter;
export function createRuntimeUpstreamRouter(
  adapters: Map<string, UpstreamAdapter>,
  modelRouting: Record<string, string>,
  apiKeyPool: ApiKeyPool,
  factoryOrPool?: AdapterFactory | ProxyPool,
  proxyPool?: ProxyPool,
): UpstreamRouter {
  let factory: AdapterFactory;
  let pool: ProxyPool | undefined;

  if (typeof factoryOrPool === "function") {
    factory = factoryOrPool;
    pool = proxyPool;
  } else {
    pool = factoryOrPool;
    factory = (entry) => createAdapterForEntry(entry, pool);
  }

  const router = new UpstreamRouter(adapters, modelRouting, "codex");
  router.setApiKeyPool(apiKeyPool, factory);
  return router;
}

