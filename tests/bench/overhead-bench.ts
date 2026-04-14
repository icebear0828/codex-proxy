#!/usr/bin/env npx tsx
/**
 * Proxy overhead benchmark — measures time spent INSIDE the proxy,
 * broken down by stage, WITHOUT hitting the upstream API.
 *
 * Directly calls internal functions to isolate each stage's cost.
 *
 * Usage: npx tsx tests/overhead-bench.ts
 */

import { loadConfig, loadFingerprint, setConfigForTesting } from "../src/config.js";
import { initContext } from "../src/context.js";
import { initProxy } from "../src/tls/curl-binary.js";
import { initTransport, getTransport } from "../src/tls/transport.js";
import { loadStaticModels } from "../src/models/model-store.js";
import { AccountPool } from "../src/auth/account-pool.js";
import { buildHeadersWithContentType } from "../src/fingerprint/manager.js";

// ── Bootstrap (same as index.ts but minimal) ──

const config = loadConfig();
const fingerprint = loadFingerprint();
initProxy();
const transport = await initTransport();
initContext(config, fingerprint, transport);
loadStaticModels();

// Create a pool with a fake account
const pool = new AccountPool({});

// ── Benchmark functions ──

function bench(label: string, fn: () => void, iterations = 1000): void {
  // Warmup
  for (let i = 0; i < 10; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations).toFixed(3);
  console.log(`  ${label.padEnd(35)} ${perOp}ms/op  (${iterations} iterations, ${Math.round(elapsed)}ms total)`);
}

async function benchAsync(label: string, fn: () => Promise<void>, iterations = 10): Promise<void> {
  // Warmup
  for (let i = 0; i < 2; i++) await fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsed = performance.now() - start;
  const perOp = (elapsed / iterations).toFixed(1);
  console.log(`  ${label.padEnd(35)} ${perOp}ms/op  (${iterations} iterations, ${Math.round(elapsed)}ms total)`);
}

// ── Tests ──

console.log("\n🔬 Proxy overhead benchmark\n");
console.log("── Synchronous operations ──");

bench("buildHeadersWithContentType()", () => {
  buildHeadersWithContentType("fake-token", "fake-account-id");
});

bench("JSON.stringify (request body)", () => {
  JSON.stringify({
    model: "gpt-5.2-codex",
    instructions: "",
    input: [{ role: "user", content: "Say hi" }],
    stream: true,
    store: false,
    reasoning: { summary: "auto", effort: "medium" },
  });
});

console.log("\n── curl-impersonate transport (real TLS handshake) ──");

// Test actual curl process spawn + TLS handshake (to a fast endpoint)
await benchAsync("curl GET https://chatgpt.com (no body)", async () => {
  const t = getTransport();
  const headers = buildHeadersWithContentType("fake", null);
  try {
    await t.get("https://chatgpt.com/backend-api/codex/usage", headers, 10);
  } catch {
    // Expected to fail (401) but we only care about timing
  }
}, 5);

// Compare: native fetch to same endpoint
await benchAsync("native fetch GET https://chatgpt.com", async () => {
  try {
    const res = await fetch("https://chatgpt.com/backend-api/codex/usage", {
      headers: { "User-Agent": "test" },
      signal: AbortSignal.timeout(10000),
    });
    await res.text();
  } catch {
    // Expected to fail
  }
}, 5);

// Test with proxy
if (config.tls.proxy_url) {
  await benchAsync(`curl GET via proxy (${config.tls.proxy_url})`, async () => {
    const t = getTransport();
    const headers = buildHeadersWithContentType("fake", null);
    try {
      await t.get("https://chatgpt.com/backend-api/codex/usage", headers, 10, config.tls.proxy_url!);
    } catch {
      // Expected
    }
  }, 5);
}

console.log("\n── Summary ──");
console.log("  If curl-impersonate is >> native fetch, the TLS impersonation layer is the bottleneck.");
console.log("  If both are similar, the bottleneck is upstream (chatgpt.com response time).");
console.log("");
