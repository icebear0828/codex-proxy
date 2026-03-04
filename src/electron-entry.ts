/**
 * Barrel entry point for Electron bundling.
 * esbuild bundles this into a single dist-electron/server.mjs with all deps included.
 */

export { setPaths } from "./paths.js";
export { startServer } from "./index.js";
export type { ServerHandle, StartOptions } from "./index.js";
