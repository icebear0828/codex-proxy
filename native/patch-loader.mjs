#!/usr/bin/env node
// napi regenerates index.js on every `napi build`, wiping the scope-aware
// require()s the npm distribution needs. Re-apply them right after each build
// so every CI job and local checkout ends up with the same loader. Idempotent:
// a build run with --js false, or a re-run, leaves the file untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const loaderPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
let source = readFileSync(loaderPath, "utf8");

if (source.includes("CODEX_NPM_SCOPE")) {
  console.log("[napi] loader already scope-aware, skipping patch");
  process.exit(0);
}

const anchor = "const { platform, arch } = process";
const scopeBlock = `${anchor}

// Platform packages share the main package's npm scope; it matches the
// distribution origin — override via CODEX_NPM_SCOPE when running from a fork.
const npmScope = process.env.CODEX_NPM_SCOPE || 'icebear0828'
function requireAddon(name) {
  return require(\`@\${npmScope}/\${name}\`)
}`;

if (!source.includes(anchor)) {
  console.error("[napi] could not find the loader anchor to patch");
  process.exit(1);
}
source = source.replace(anchor, scopeBlock);
source = source.replace(/require\(('codex-tls-[^']+')\)/g, "requireAddon($1)");

writeFileSync(loaderPath, source);
console.log("[napi] patched the loader with scope-aware addon require()s");
