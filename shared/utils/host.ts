/**
 * Re-export hostname helpers from src/utils/host.ts.
 *
 * The implementation lives under src/ so tsc (rootDir=src) can compile it for
 * the server bundle. This thin shim lets the web frontend keep its existing
 * `shared/utils/host` import path and avoids duplicating the regex/octet logic.
 */
export {
  normalizeHostname,
  isLoopbackHostname,
  isNetworkExposedHost,
} from "../../src/utils/host.js";
