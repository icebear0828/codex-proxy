/**
 * Opt-in request/event dumper for diagnosing edge cases (e.g. account-switch
 * retry storms, premature stream closes).
 *
 * Activation: set `CODEX_PROXY_DEBUG_DUMP=1` in the env. When unset, every
 * function in this module is a no-op and incurs zero overhead beyond a
 * boolean check.
 *
 * Output: a single JSONL file at `/tmp/codex-proxy-dump-<startupMs>.jsonl`,
 * one line per event, with `ts`, `kind`, and arbitrary payload fields. Path
 * is logged once at startup so users know where to look.
 *
 * **Privacy warning:** the dump contains full request payloads (including
 * user prompts) and upstream response chunks. Treat the file as sensitive.
 */
import * as fs from "node:fs";

const ENABLED = !!process.env.CODEX_PROXY_DEBUG_DUMP;
const DUMP_PATH = ENABLED ? `/tmp/codex-proxy-dump-${Date.now()}.jsonl` : null;
let announced = false;

export function debugDumpEnabled(): boolean {
  return ENABLED;
}

export function debugDumpPath(): string | null {
  return DUMP_PATH;
}

export function debugDump(kind: string, payload: Record<string, unknown>): void {
  if (!DUMP_PATH) return;
  if (!announced) {
    announced = true;
    console.warn(`[debug-dump] writing to ${DUMP_PATH} — file may contain sensitive request bodies`);
  }
  try {
    const line = JSON.stringify({ ts: Date.now(), kind, ...payload }) + "\n";
    fs.appendFileSync(DUMP_PATH, line);
  } catch {
    // never crash on dump errors
  }
}
