#!/usr/bin/env node
// npm-distribution launcher: re-executes the Lite server wrapper from the
// installed package so `codex-proxy` behaves like the Lite shell launchers
// (same argument surface: --mode, --host, --port, --portable, ...).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// No --portable default: like the Lite shell launchers, runtime data goes to
// the per-user data directory (server.mjs resolves it via CODEX_PROXY_DATA_DIR
// or the platform default), so `npm i -g` updates never wipe user data.

const server = join(packageRoot, "app", "server.mjs");
const child = spawn(process.execPath, [server, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
