/**
 * ABI smoke test for a freshly built codex-tls addon.
 *
 * Loads the platform .node through the committed napi loader and asserts the
 * public export surface — no network access needed. Run from the repo root
 * after `napi build`.
 *
 * Exits non-zero when the addon is missing exports or fails to load, which is
 * how broken builds (wrong ABI, missing symbols, bad linkage) surface.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

const loaderPath = resolve("native/index.js");
const require = createRequire(loaderPath);
const bindings = require(loaderPath);

const required = ["httpGet", "httpPost", "httpPostStream", "httpCancel"];
const missing = required.filter((k) => typeof bindings[k] !== "function");
if (missing.length > 0) {
  console.error(`addon smoke FAILED — missing exports: ${missing.join(", ")}`);
  console.error(`available: ${Object.keys(bindings).join(", ")}`);
  process.exit(1);
}

// Cancelling an unknown id must report false, not throw — this exercises the
// registry lock/unlock path in the native layer.
if (bindings.httpCancel("smoke-nonexistent-request") !== false) {
  console.error("addon smoke FAILED — httpCancel(bogus id) must return false");
  process.exit(1);
}

console.log(`addon smoke OK — exports: ${required.join(", ")}`);
