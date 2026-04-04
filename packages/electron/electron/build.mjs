/**
 * esbuild script — bundles Electron main + backend server.
 *
 * Output:
 *   dist-electron/main.cjs    — Electron main process (CJS)
 *   dist-electron/server.mjs  — Backend server bundle (ESM, all deps included)
 *
 * The server bundle eliminates the need for node_modules at runtime,
 * solving the ESM+asar module resolution issue.
 */

import { build } from "esbuild";

// 1. Electron main process → CJS (loaded by Electron directly)
await build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist-electron/main.cjs",
  external: ["electron"],
  target: "node20",
  sourcemap: true,
});

console.log("[esbuild] dist-electron/main.cjs built successfully");

// 2. Backend server → ESM (dynamically imported by main.cjs)
//    All npm deps (hono, zod, js-yaml, etc.) are bundled in.
//    Only Node builtins and optional native modules are external.
await build({
  entryPoints: ["src/electron-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist-electron/server.mjs",
  external: [],
  target: "node20",
  sourcemap: true,
  // Mark .node files as external (native addons)
  loader: { ".node": "empty" },
});

console.log("[esbuild] dist-electron/server.mjs built successfully");
