import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "path";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      "preact": path.resolve(__dirname, "node_modules/preact"),
      "preact/hooks": path.resolve(__dirname, "node_modules/preact/hooks"),
      "preact/jsx-runtime": path.resolve(__dirname, "node_modules/preact/jsx-runtime/dist/jsxRuntime.mjs"),
      "preact/jsx-dev-runtime": path.resolve(__dirname, "node_modules/preact/jsx-runtime/dist/jsxRuntime.mjs"),
      "@shared": path.resolve(__dirname, "..", "..", "..", "shared"),
    },
  },
  base: "/desktop/",
  build: {
    outDir: "../public-desktop",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/v1": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/health": "http://localhost:8080",
      "/debug": "http://localhost:8080",
      "/admin": "http://localhost:8080",
    },
  },
});
