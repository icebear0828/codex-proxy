import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_URL = "https://go.microsoft.com/fwlink/?linkid=2124703";
const DEFAULT_OUT = resolve(ROOT, "portable-release", "tools", "MicrosoftEdgeWebView2Setup.exe");

function parseArgs(argv) {
  const options = {
    url: process.env.WEBVIEW2_BOOTSTRAPPER_URL ?? DEFAULT_URL,
    out: process.env.WEBVIEW2_BOOTSTRAPPER_OUT ?? DEFAULT_OUT,
    sha256: process.env.WEBVIEW2_BOOTSTRAPPER_SHA256?.toLowerCase() ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--url", "--out", "--sha256"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--url") options.url = value;
      else if (arg === "--out") options.out = resolve(value);
      else options.sha256 = value.toLowerCase();
      continue;
    }
    if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg.startsWith("--out=")) options.out = resolve(arg.slice("--out=".length));
    else if (arg.startsWith("--sha256=")) options.sha256 = arg.slice("--sha256=".length).toLowerCase();
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const response = await fetch(options.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Bootstrapper download failed: HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length < 1024 || content.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("Downloaded WebView2 Bootstrapper is not a Windows executable");
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (options.sha256 && options.sha256 !== sha256) {
    throw new Error(`Bootstrapper SHA-256 mismatch: expected ${options.sha256}, got ${sha256}`);
  }
  mkdirSync(dirname(options.out), { recursive: true });
  const temporary = `${options.out}.part-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { mode: 0o755 });
  renameSync(temporary, options.out);
  writeFileSync(`${options.out}.sha256`, `${sha256}  ${options.out.split(/[\\/]/).pop()}\n`);
  console.log(`[webview2] bootstrapper: ${options.out}`);
  console.log(`[webview2] bytes: ${content.length}`);
  console.log(`[webview2] sha256: ${sha256}`);
  console.log(`[webview2] source: ${options.url}`);
}

main().catch((error) => {
  console.error(`[webview2] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
