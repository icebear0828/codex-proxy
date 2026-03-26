/**
 * Barrel entry point for Electron bundling.
 * esbuild bundles this into a single dist-electron/server.mjs with all deps included.
 */

export { setPaths } from "../../../src/paths.js";
export { startServer } from "../../../src/index.js";
export type { ServerHandle, StartOptions } from "../../../src/index.js";
export { getConfig } from "../../../src/config.js";
