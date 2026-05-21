/**
 * Side-effect import: in dev, tee process.stdout/stderr to logs/dev-YYYY-MM-DD.log
 * so terminal scrollback isn't the only place we can debug from.
 *
 * Skipped in production (log shippers handle persistence) and under Vitest.
 */

import { join } from "node:path";

import { installFileLogger } from "./log-file.js";

const isProduction = process.env.NODE_ENV === "production";
const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
const disabled = process.env.CODEX_PROXY_FILE_LOG === "0";

if (!isProduction && !isTest && !disabled) {
  try {
    installFileLogger({ dir: join(process.cwd(), "logs") });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dev-file-logger] failed to install: ${msg}\n`);
  }
}
