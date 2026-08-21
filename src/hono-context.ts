import type { ClientKeyEntry } from "./auth/client-key-types.js";
import type { ClientKeyPool } from "./auth/client-key-pool.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    authRole?: "master" | "client_key";
    clientKey?: ClientKeyEntry;
    clientKeyPool?: ClientKeyPool;
  }
}

export {};
