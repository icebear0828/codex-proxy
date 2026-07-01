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

const path_config = {};
const assign_upstream_path = (target, upstream_key, value) => {
  target[upstream_key] = value;
};
assign_upstream_path(path_config, "rootDir", root_dir);
assign_upstream_path(path_config, "configDir", resolve(root_dir, "config"));
assign_upstream_path(path_config, "dataDir", data_dir);
assign_upstream_path(path_config, "binDir", resolve(root_dir, "bin"));
assign_upstream_path(path_config, "publicDir", resolve(root_dir, "public"));
setPaths(path_config);

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
