import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "path";

const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: [
      // Allow shared/ files outside web/ to resolve preact from web/node_modules.
      // devtools/debug are injected by @preact/preset-vite's transform into
      // shared/ files; without these aliases a clean install (CI) cannot resolve
      // them from outside web/ and the web tests fail at import time.
      { find: /^preact$/, replacement: path.resolve(__dirname, "node_modules/preact") },
      { find: /^preact\/hooks$/, replacement: path.resolve(__dirname, "node_modules/preact/hooks") },
      { find: /^preact\/jsx-runtime$/, replacement: path.resolve(__dirname, "node_modules/preact/jsx-runtime") },
      { find: /^preact\/jsx-dev-runtime$/, replacement: path.resolve(__dirname, "node_modules/preact/jsx-runtime") },
      { find: /^preact\/devtools$/, replacement: path.resolve(__dirname, "node_modules/preact/devtools") },
      { find: /^preact\/debug$/, replacement: path.resolve(__dirname, "node_modules/preact/debug") },
    ],
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": proxyTarget,
      "/auth": proxyTarget,
      "/health": proxyTarget,
      "/debug": proxyTarget,
      "/admin": proxyTarget,
    },
  },
});
