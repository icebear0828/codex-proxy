/**
 * CLI entry for Claude -> Grok LB proxy (isolated data dir, port 8088).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../dist/index.js";
import { setPaths } from "../dist/paths.js";

const root_dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data_dir =
  process.env.CODEX_PROXY_GROK_CLAUDE_DATA?.trim() || resolve(root_dir, "data-grok-claude");

setPaths({
  // @harness:complex upstream setPaths API uses camelCase property names
  rootDir: root_dir,
  configDir: resolve(root_dir, "config"),
  dataDir: data_dir,
  binDir: resolve(root_dir, "bin"),
  publicDir: resolve(root_dir, "public"),
});

const port = parseInt(process.env.PORT || "8088", 10);
const host = process.env.CODEX_PROXY_HOST || "127.0.0.1";

const handle = await startServer({ host, port });
console.log(
  `[grok-claude-proxy] http://${host}:${handle.port} -> Grok LB :2477 (data: ${data_dir})`,
);

const shutdown = () => {
  handle
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
