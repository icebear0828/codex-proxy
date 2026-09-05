import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  let packageDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--package-dir") packageDir = argv[++i];
    else if (arg.startsWith("--package-dir=")) packageDir = arg.slice("--package-dir=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node test-linux-x64-musl.mjs --package-dir <extracted-lite-package>");
      process.exit(0);
    } else {
      throw new Error("Unknown option: " + arg);
    }
  }
  if (!packageDir) throw new Error("--package-dir is required");
  return resolve(packageDir);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function close(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function main() {
  const packageDir = parseArgs(process.argv.slice(2));
  const nativeDir = join(packageDir, "native");
  const addonPath = join(nativeDir, "codex-tls.linux-x64-musl.node");
  const loaderPath = join(nativeDir, "index.js");

  assert(existsSync(addonPath), "musl native addon is missing: " + addonPath);
  assert(existsSync(loaderPath), "native loader is missing: " + loaderPath);

  const image = readFileSync(addonPath);
  assert(image.length >= 20, "musl native addon is too small to be an ELF image");
  assert(image.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    "musl native addon is not an ELF image");
  assert(image[4] === 2 && image[5] === 1,
    "musl native addon is not a little-endian 64-bit ELF image");
  assert(image.readUInt16LE(18) === 0x3e,
    "musl native addon is not an x86-64 ELF image");

  // Requiring the generated loader verifies musl detection and binding
  // selection, rather than only checking the .node filename.
  const requireFromNative = createRequire(loaderPath);
  const bindings = requireFromNative(loaderPath);
  for (const name of ["httpGet", "httpPost", "httpPostStream"]) {
    assert(typeof bindings[name] === "function", "native loader is missing " + name);
  }

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/musl-smoke") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("codex-tls-musl-ok");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  try {
    const address = server.address();
    assert(address && typeof address === "object", "local smoke server did not expose an address");
    const result = await bindings.httpGet(
      `http://127.0.0.1:${address.port}/musl-smoke`,
      { "x-codex-proxy-musl-smoke": "1" },
      5,
      null,
      true,
    );
    assert(result.status === 200, "native musl HTTP GET returned " + result.status);
    assert(result.body === "codex-tls-musl-ok", "native musl HTTP GET returned an unexpected body");
  } finally {
    await close(server);
  }

  console.log("[native-musl-test] PASS loaded linux-x64-musl addon and completed local HTTP GET");
}

main().catch((error) => {
  console.error("[native-musl-test] FAIL: " + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
