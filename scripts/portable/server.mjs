import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(APP_DIR, "..");
const WEBVIEW2_RUNTIME_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_INSTALL_HELP_URL = "https://developer.microsoft.com/microsoft-edge/webview2/";
const PROMPT_TIMEOUT_MS = 15_000;
const ELECTRON_USER_DATA_SCOPE = ["@codex-proxy", "electron"];

function usage() {
  console.log(`Usage: node app/server.mjs [options]

Options:
  --mode, -m <mode>          server, browser, auto, or webview2
  --portable, -p             Store runtime data in the package's data directory
  --host, -H <host>          Override the listen host
  --port, -P <port>          Override the listen port; use 0 for an ephemeral port
  --webview2-host, -w <path> Use a specific WebView2 host executable
  --help, -h                 Show this help
`);
}

function parseArgs(argv) {
  const options = { mode: "auto", portable: false, host: undefined, port: undefined, webview2Host: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--portable" || arg === "-p") {
      options.portable = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (["--mode", "-m", "--host", "-H", "--port", "-P", "--webview2-host", "-w"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--mode" || arg === "-m") options.mode = value;
      if (arg === "--host" || arg === "-H") options.host = value;
      if (arg === "--port" || arg === "-P") options.port = Number(value);
      if (arg === "--webview2-host" || arg === "-w") options.webview2Host = value;
      continue;
    }
    if (arg.startsWith("--mode=") || arg.startsWith("-m=")) options.mode = arg.slice(arg.indexOf("=") + 1);
    else if (arg.startsWith("--host=") || arg.startsWith("-H=")) options.host = arg.slice(arg.indexOf("=") + 1);
    else if (arg.startsWith("--port=") || arg.startsWith("-P=")) options.port = Number(arg.slice(arg.indexOf("=") + 1));
    else if (arg.startsWith("--webview2-host=") || arg.startsWith("-w=")) options.webview2Host = arg.slice(arg.indexOf("=") + 1);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!["server", "browser", "auto", "webview2"].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return options;
}

function displayHost(host) {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function defaultUserDataDir() {
  let baseDir;
  if (process.platform === "win32") {
    baseDir = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    baseDir = join(homedir(), "Library", "Application Support");
  } else {
    baseDir = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  }
  return resolve(baseDir, ...ELECTRON_USER_DATA_SCOPE, "data");
}

function openExternal(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", (error) => {
    console.warn(`[Portable] Could not open browser with ${command}: ${error.message}`);
  });
  child.unref();
}

function webview2RegistryKeys() {
  const client = `\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_GUID}`;
  return [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_GUID}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_RUNTIME_GUID}`,
    `HKCU${client}`,
  ];
}

function hasWebView2Runtime() {
  if (process.platform !== "win32") return false;
  if (process.env.CODEX_PROXY_FORCE_NO_WEBVIEW2 === "1") return false;

  // Microsoft documents the pv value in the per-machine and per-user EdgeUpdate
  // keys. Query both registry views because the package may be launched by an
  // x86 Node process on a 64-bit Windows installation.
  const views = process.arch === "ia32" ? ["32", "64"] : ["64", "32"];
  for (const key of webview2RegistryKeys()) {
    for (const view of views) {
      try {
        const output = execFileSync("reg.exe", ["query", key, "/v", "pv", `/reg:${view}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        const match = /^\s*pv\s+REG_SZ\s+(\S+)\s*$/im.exec(output);
        const version = match?.[1];
        if (version && version !== "0.0.0.0" && /^\d+(?:\.\d+){1,3}$/.test(version)) return true;
      } catch {
        // A missing key or an unavailable registry view means that this
        // particular location is not usable. Continue with the other views.
      }
    }
  }
  return false;
}

function askYesNoWithTimeout(question, timeoutMs = PROMPT_TIMEOUT_MS) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("[Portable] No interactive terminal is available; skipping the optional installation.");
    return Promise.resolve(false);
  }

  return new Promise((resolveAnswer) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readline.close();
      resolveAnswer(answer);
    };
    const timer = setTimeout(() => {
      console.log("\n[Portable] No answer received; continuing without installation.");
      finish(false);
    }, timeoutMs);

    readline.question(`${question} [y/N] `, (answer) => {
      finish(/^(?:y|yes)$/i.test(answer.trim()));
    });
    readline.once("SIGINT", () => finish(false));
  });
}

function resolveWebView2Bootstrapper() {
  const configured = process.env.CODEX_PROXY_WEBVIEW2_BOOTSTRAPPER;
  if (configured) return resolve(PACKAGE_ROOT, configured);
  return join(PACKAGE_ROOT, "tools", "MicrosoftEdgeWebView2Setup.exe");
}

function runWebView2Installer(installer) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(installer, ["/silent", "/install"], {
        cwd: PACKAGE_ROOT,
        stdio: "inherit",
        windowsHide: false,
      });
    } catch (error) {
      console.error(`[Portable] Could not start WebView2 Bootstrapper: ${error.message}`);
      resolveResult(1);
      return;
    }
    child.once("error", (error) => {
      console.error(`[Portable] Could not start WebView2 Bootstrapper: ${error.message}`);
      resolveResult(1);
    });
    child.once("close", (code) => resolveResult(code ?? 1));
  });
}

async function waitForWebView2Runtime() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (hasWebView2Runtime()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return false;
}

function resolveWebView2Host(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(resolve(PACKAGE_ROOT, explicitPath));
  if (process.env.CODEX_PROXY_WEBVIEW2_HOST) {
    candidates.push(resolve(PACKAGE_ROOT, process.env.CODEX_PROXY_WEBVIEW2_HOST));
  }

  const architectureCandidates = {
    ia32: ["win-x86"],
    x64: ["win-x64", "win-x86"],
    arm64: ["win-arm64", "win-x64", "win-x86"],
  }[process.arch] ?? ["win-x64", "win-x86"];
  candidates.push(
    ...architectureCandidates.map((architecture) =>
      join(PACKAGE_ROOT, "hosts", "webview2", architecture, "webview2-host.exe")),
    join(PACKAGE_ROOT, "hosts", "webview2", "webview2-host.exe"),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const options = parseArgs(process.argv.slice(2));
// Keep all package-relative resources and process.cwd()-based backend behavior
// anchored to the distribution directory, even when node is invoked directly
// from another working directory.
process.chdir(PACKAGE_ROOT);
const dataDir = options.portable
  ? join(PACKAGE_ROOT, "data")
  : process.env.CODEX_PROXY_DATA_DIR?.trim()
    ? resolve(process.env.CODEX_PROXY_DATA_DIR)
    : defaultUserDataDir();

// The side-effect logger is evaluated while importing the bundle, so expose
// the selected data directory before that import. The explicit path set below
// then freezes the same layout for the complete backend lifetime.
process.env.CODEX_PROXY_DATA_DIR = dataDir;
const { getConfig, setPaths, startServer } = await import("./server-bundle.mjs");
setPaths({
  rootDir: PACKAGE_ROOT,
  configDir: join(PACKAGE_ROOT, "config"),
  dataDir,
  binDir: join(PACKAGE_ROOT, "bin"),
  publicDir: join(PACKAGE_ROOT, "public"),
  embedded: false,
  distribution: "lite",
});
console.log(`[Portable] Data directory: ${dataDir}${options.portable ? " (portable)" : " (user profile)"}`);
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  console.error(`[Portable] Node.js 20 or newer is required; found ${process.versions.node}`);
  process.exit(2);
}
let handle;
let uiProcess;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (uiProcess && !uiProcess.killed) uiProcess.kill();
  try {
    await handle?.close();
  } catch (error) {
    console.error(`[Portable] Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

async function start() {
  let launchMode = options.mode;
  let webview2Host;
  let autoSelectedWebView2 = false;
  let autoBrowserFallbackStarted = false;
  if (launchMode === "auto") {
    if (process.platform === "win32") {
      const candidate = resolveWebView2Host(options.webview2Host);
      if (candidate && hasWebView2Runtime()) {
        launchMode = "webview2";
        webview2Host = candidate;
        autoSelectedWebView2 = true;
      } else {
        launchMode = "browser";
        if (candidate) {
          console.warn("[Portable] WebView2 Runtime was not detected; falling back to the default browser.");
        } else {
          console.warn("[Portable] Packaged WebView2 host was not found; falling back to the default browser.");
        }
      }
    } else {
      launchMode = "browser";
    }
  }

  if (launchMode === "webview2") {
    if (process.platform !== "win32") {
      throw new Error("WebView2 mode is only available on Windows");
    }
    webview2Host ??= resolveWebView2Host(options.webview2Host);
    if (!webview2Host) {
      throw new Error(
        "WebView2 host was not found. Provide hosts/webview2/webview2-host.exe or use --mode=browser.",
      );
    }
    if (!hasWebView2Runtime()) {
      const installer = resolveWebView2Bootstrapper();
      const installerAvailable = existsSync(installer);
      const question = installerAvailable
        ? "WebView2 Runtime is not installed. Run the packaged online installer now? (15 seconds)"
        : "WebView2 Runtime is not installed. Open the official installation page now? (15 seconds)";
      if (await askYesNoWithTimeout(question)) {
        if (installerAvailable) {
          console.log(`[Portable] Running WebView2 Bootstrapper: ${installer}`);
          const exitCode = await runWebView2Installer(installer);
          if (exitCode !== 0 || !(await waitForWebView2Runtime())) {
            throw new Error("WebView2 Runtime installation did not complete. Use --mode=browser or install it manually.");
          }
        } else {
          openExternal(WEBVIEW2_INSTALL_HELP_URL);
          throw new Error("WebView2 Runtime is required for --mode=webview2; installation guidance was opened.");
        }
      } else {
        throw new Error("WebView2 Runtime is required for --mode=webview2; use --mode=browser instead.");
      }
    }
  }

  const startOptions = {};
  if (options.host !== undefined) startOptions.host = options.host;
  if (options.port !== undefined) startOptions.port = options.port;

  try {
    handle = await startServer(startOptions);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || options.port !== undefined) throw error;
    console.warn("[Portable] Configured port is busy; retrying with a random port");
    handle = await startServer({ ...startOptions, port: 0 });
  }

  const configuredHost = options.host ?? getConfig().server.host;
  const url = `http://${displayHost(configuredHost)}:${handle.port}/`;
  if (launchMode === "webview2" && process.env.CODEX_PROXY_NATIVE_TRAY === "1") {
    // The native Windows launcher owns the GUI child so that closing the
    // WebView2 window does not also close the server and its tray icon.
    console.log(`CODEX_PROXY_WEBVIEW2_HOST=${webview2Host}`);
  }
  console.log(`CODEX_PROXY_READY=${url}`);

  if (launchMode === "browser") {
    openExternal(url);
    return;
  }

  if (launchMode === "webview2") {
    if (process.env.CODEX_PROXY_NATIVE_TRAY === "1") return;

    console.log(`[Portable] Starting WebView2 host: ${webview2Host}`);
    uiProcess = spawn(webview2Host, ["--url", url], {
      cwd: PACKAGE_ROOT,
      stdio: "inherit",
      windowsHide: false,
    });
    uiProcess.once("error", (error) => {
      if (autoSelectedWebView2 && !shuttingDown) {
        console.warn(`[Portable] WebView2 host failed: ${error.message}; falling back to the default browser.`);
        autoBrowserFallbackStarted = true;
        uiProcess = undefined;
        openExternal(url);
        return;
      }
      console.error(`[Portable] WebView2 host failed: ${error.message}`);
      uiProcess = undefined;
    });
    uiProcess.once("close", (code) => {
      if (!shuttingDown && autoSelectedWebView2 && code !== 0) {
        console.warn(`[Portable] WebView2 host exited with code ${code}; falling back to the default browser.`);
        autoBrowserFallbackStarted = true;
        uiProcess = undefined;
        openExternal(url);
        return;
      }
      if (autoBrowserFallbackStarted) return;
      uiProcess = undefined;
      if (!shuttingDown) {
        console.log(`[Portable] WebView2 host closed (code ${code ?? 0}); server remains available at ${url}`);
      }
    });
  }
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

start().catch(async (error) => {
  console.error(`[Portable] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
});
