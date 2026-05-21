import type { ApiKeyPool } from "../auth/api-key-pool.js";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import { createAdapterForEntry } from "./adapter-factory.js";
import { UpstreamRouter, type AdapterFactory } from "./upstream-router.js";

export function createRuntimeUpstreamRouter(
  adapters: Map<string, UpstreamAdapter>,
  modelRouting: Record<string, string>,
  apiKeyPool: ApiKeyPool,
  adapterFactory: AdapterFactory = createAdapterForEntry,
): UpstreamRouter {
  const router = new UpstreamRouter(adapters, modelRouting, "codex");
  router.setApiKeyPool(apiKeyPool, adapterFactory);
  return router;
}
