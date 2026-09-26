/**
 * Toxiproxy lifecycle + REST client for the netlab.
 *
 * Two modes, selected by NETLAB_TOXIPROXY (default "binary"):
 *
 *   binary  — run the official toxiproxy-server.exe on the host. Everything
 *             stays on loopback (28443 → 18443), no container networking on
 *             the critical path. The binary is downloaded once into .bin/.
 *   docker  — run the official image; upstream must be reachable from the
 *             container (Docker Desktop: host.docker.internal works; plain
 *             WSL2 engines need --add-host, which this machine's engine
 *             does not honor — hence binary is the default here).
 *
 * Toxic injection happens per scenario through the REST API; between
 * scenarios the proxy entry is recreated fresh so no toxic leaks.
 *
 * Ports (all in the 28xxx band to avoid the proxy auto-detect range):
 *   28474  HTTP API
 *   28443  TCP listener → mock upstream
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(HERE, "..", ".bin");
const SERVER_EXE = path.join(BIN_DIR, "toxiproxy-server.exe");
const BINARY_URL =
  "https://github.com/Shopify/toxiproxy/releases/download/v2.12.0/toxiproxy-server-windows-amd64.exe";

export const API_PORT = 28474;
export const LISTEN_PORT = 28443;
export const MOCK_PORT = 18443;
const CONTAINER_NAME = "netlab-toxiproxy";
const IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
const MODE = (process.env.NETLAB_TOXIPROXY ?? "binary").toLowerCase();
const API = `http://127.0.0.1:${API_PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`toxiproxy API ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function apiHealthy() {
  try {
    await apiFetch("/version");
    return true;
  } catch {
    return false;
  }
}

// ── binary mode ──────────────────────────────────────────────────────

async function ensureBinary(logger) {
  if (existsSync(SERVER_EXE)) return;
  mkdirSync(BIN_DIR, { recursive: true });
  logger.log(`[toxiproxy] downloading server binary …`);
  const res = await fetch(BINARY_URL);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} from ${BINARY_URL}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(SERVER_EXE));
  logger.log(`[toxiproxy] saved ${SERVER_EXE}`);
}

let _serverChild = null;

async function startBinaryMode(logger) {
  await ensureBinary(logger);
  _serverChild = spawn(SERVER_EXE, ["-host", "127.0.0.1", "-port", String(API_PORT)], {
    stdio: "ignore",
    windowsHide: true,
  });
  _serverChild.on("exit", (code) => { _serverChild = null; });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await apiHealthy()) {
      logger.log("[toxiproxy] API is up (binary mode)");
      return;
    }
    await sleep(300);
  }
  throw new Error(`toxiproxy-server did not come up on :${API_PORT}`);
}

// ── docker mode ──────────────────────────────────────────────────────

function docker(args) {
  return new Promise((resolve, reject) => {
    // docker may be a .bat shim on Windows — node refuses .bat without shell.
    const child = spawn("docker", args, {
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`docker ${args.join(" ")} → exit ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

async function startDockerMode(logger) {
  try {
    await docker(["rm", "-f", CONTAINER_NAME]);
  } catch { /* not present */ }
  logger.log(`[toxiproxy] starting container ${IMAGE}…`);
  await docker([
    "run", "-d",
    "--name", CONTAINER_NAME,
    "-p", `${API_PORT}:8474`,
    "-p", `${LISTEN_PORT}:${LISTEN_PORT}`,
    IMAGE,
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await apiHealthy()) {
      logger.log("[toxiproxy] API is up (docker mode)");
      return;
    }
    await sleep(500);
  }
  throw new Error(`Toxiproxy API did not come up on :${API_PORT}. Inspect: docker logs ${CONTAINER_NAME}`);
}

// ── shared lifecycle ─────────────────────────────────────────────────

export async function ensureToxiproxy(logger = console) {
  if (await apiHealthy()) {
    logger.log("[toxiproxy] reusing running instance");
    return;
  }
  if (MODE === "docker") {
    await startDockerMode(logger);
  } else {
    await startBinaryMode(logger);
  }
}

export async function stopToxiproxy() {
  if (_serverChild) {
    const child = _serverChild;
    _serverChild = null;
    child.kill();
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
    return;
  }
  if (MODE === "docker") {
    try {
      await docker(["rm", "-f", CONTAINER_NAME]);
    } catch { /* already gone */ }
  }
}

/** Recreate the forwarder with no toxics — a clean slate per scenario. */
export async function resetProxyEntry() {
  try {
    await apiFetch(`/proxies/netlab-mock`, { method: "DELETE" });
  } catch { /* absent on first use */ }
  await apiFetch("/proxies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "netlab-mock",
      listen: `127.0.0.1:${LISTEN_PORT}`,
      upstream: `127.0.0.1:${MOCK_PORT}`,
      enabled: true,
    }),
  });
}

/**
 * Add a toxic. See https://github.com/Shopify/toxiproxy#toxics — the
 * scenarios use: latency, bandwidth, slicer, limit_data, timeout, reset_peer.
 */
export async function addToxic(toxic) {
  return apiFetch("/proxies/netlab-mock/toxics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toxic),
  });
}

export async function clearToxics() {
  const toxics = await apiFetch("/proxies/netlab-mock/toxics");
  for (const t of toxics ?? []) {
    await apiFetch(`/proxies/netlab-mock/toxics/${encodeURIComponent(t.name)}`, {
      method: "DELETE",
    }).catch(() => { /* raced close */ });
  }
}
