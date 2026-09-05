import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log("Usage: node test-linux-x64-musl.mjs <addon-path>");
    process.exit(0);
  }
  if (argv.length !== 1) {
    throw new Error("Usage: node test-linux-x64-musl.mjs <addon-path>");
  }
  return resolve(argv[0]);
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
  const addonPath = parseArgs(process.argv.slice(2));
  const image = readFileSync(addonPath);

  assert(image.length >= 20, "musl native addon is too small to be an ELF image");
  assert(image.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    "musl native addon is not an ELF image");
  assert(image[4] === 2 && image[5] === 1,
    "musl native addon is not a little-endian 64-bit ELF image");
  assert(image.readUInt16LE(18) === 0x3e,
    "musl native addon is not an x86-64 ELF image");

  const bindings = createRequire(import.meta.url)(addonPath);
  for (const name of ["httpGet", "httpPost", "httpPostStream"]) {
    assert(typeof bindings[name] === "function", "native addon is missing " + name);
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
