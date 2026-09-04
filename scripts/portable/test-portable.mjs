import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { basename, delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function parseArgs(argv) {
  const options = {
    archive: null,
    keep: false,
    requireWindowsExe: false,
    requireWebView2: false,
    testNativeLauncher: false,
    skipRuntime: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--require-windows-exe") options.requireWindowsExe = true;
    else if (arg === "--require-webview2") options.requireWebView2 = true;
    else if (arg === "--test-native-launcher") options.testNativeLauncher = true;
    else if (arg === "--skip-runtime") options.skipRuntime = true;
    else if (arg === "--archive") options.archive = argv[++i];
    else if (arg.startsWith("--archive=")) options.archive = arg.slice("--archive=".length);
    else if (!arg.startsWith("-") && !options.archive) options.archive = arg;
    else throw new Error("Unknown option: " + arg);
  }
  if (!options.archive) throw new Error("--archive is required");
  return { ...options, archive: resolve(options.archive) };
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function findPython() {
  return ["python", "python3"].find(commandExists) ?? null;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: (result.stdout ?? "") + (result.stderr ?? ""),
    error: result.error,
  };
}

function testEnvironment(extra = {}) {
  const env = { ...process.env };
  delete env.PORT;
  return { ...env, ...extra };
}

function normalizeEntryName(name) {
  return name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function canonicalPath(path) {
  if (!path) return path;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function extractArchive(archive, destination) {
  const python = findPython();
  if (!python) throw new Error("Python 3 is required by the portable archive test to read tar.xz metadata");
  const script = [
    "import json, sys, tarfile",
    "archive, destination = sys.argv[1:3]",
    "with tarfile.open(archive, 'r:xz') as source:",
    "    members = source.getmembers()",
    "    source.extractall(destination)",
    "print(json.dumps([{'name': m.name, 'mode': m.mode, 'size': m.size, 'isfile': m.isfile()} for m in members]))",
  ].join("\n");
  const result = runSync(python, ["-c", script, archive, destination], { timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Unable to extract " + archive + ": " +
      (result.output || result.error?.message || "exit " + result.status),
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      "Portable archive metadata was not valid JSON: " + error.message +
      (result.stderr ? "\nPython stderr:\n" + result.stderr : ""),
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nativeCandidates(platform, arch) {
  if (platform === "win32") {
    return {
      ia32: ["win32-ia32-msvc"],
      x64: ["win32-x64-msvc"],
      arm64: ["win32-arm64-msvc", "win32-x64-msvc"],
    }[arch] ?? [];
  }
  if (platform === "darwin") {
    return {
      x64: ["darwin-x64", "darwin-universal"],
      arm64: ["darwin-arm64", "darwin-universal"],
    }[arch] ?? [];
  }
  if (platform === "linux") {
    return {
      x64: ["linux-x64-gnu", "linux-x64-musl"],
      arm64: ["linux-arm64-gnu", "linux-arm64-musl"],
      arm: ["linux-arm-gnueabihf", "linux-arm-musleabihf"],
      riscv64: ["linux-riscv64-gnu", "linux-riscv64-musl"],
      s390x: ["linux-s390x-gnu"],
    }[arch] ?? [];
  }
  if (platform === "freebsd" && arch === "x64") return ["freebsd-x64"];
  return [];
}

function archiveContract(entries, extract, options) {
  const files = new Map(
    entries
      .filter((entry) => entry.isfile)
      .map((entry) => [normalizeEntryName(entry.name), entry]),
  );
  const names = new Set(entries.map((entry) => normalizeEntryName(entry.name)));
  const required = [
    "codex-proxy.sh",
    "codex-proxy.cmd",
    "app/server.mjs",
    "app/server-bundle.mjs",
    "app/manifest.json",
    "native/index.js",
    "native/index.d.ts",
    "native/package.json",
    "hosts/webview2",
    "data",
  ];
  for (const name of required) assert(names.has(name), "Portable archive is missing " + name);

  const shellEntry = files.get("codex-proxy.sh");
  assert(shellEntry, "Portable archive is missing the shell launcher file entry");
  assert(
    (shellEntry.mode & 0o111) !== 0,
    "codex-proxy.sh is not executable in the archive (mode " + shellEntry.mode.toString(8) + ")",
  );
  assert(
    (shellEntry.mode & 0o777) === 0o755,
    "codex-proxy.sh must have mode 0755 in the archive (mode " + shellEntry.mode.toString(8) + ")",
  );

  const manifest = JSON.parse(readFileSync(join(extract, "app", "manifest.json"), "utf8"));
  assert(manifest.name === "codex-proxy-lite", "Lite manifest has an unexpected name: " + manifest.name);
  assert(typeof manifest.version === "string" && manifest.version.length > 0, "Lite manifest has no version");
  const versionMatch = /^codex-proxy-(.+)-no-node-lite-all-platforms\.tar\.xz$/i.exec(basename(options.archive));
  if (versionMatch) {
    assert(manifest.version === versionMatch[1],
      "Lite manifest version " + manifest.version + " does not match archive version " + versionMatch[1]);
  }
  assert(manifest.bundledNode === false, "Portable manifest must not claim to bundle Node.js");
  assert(manifest.minimumNodeMajor >= 20, "Unexpected portable Node.js minimum: " + manifest.minimumNodeMajor);
  assert(
    JSON.stringify(manifest.modes) === JSON.stringify(["server", "browser", "auto", "webview2"]),
    "Portable modes changed unexpectedly",
  );
  const nativePackage = JSON.parse(readFileSync(join(extract, "native", "package.json"), "utf8"));
  assert(nativePackage.type === "commonjs", "Portable native loader must have a CommonJS package boundary");

  const nodeRuntimeEntries = [...names].filter((name) =>
    /(^|\/)(?:node(?:\.exe)?|nodejs(?:\.exe)?|node_modules)(?:\/|$)/i.test(name));
  assert(nodeRuntimeEntries.length === 0,
    "Lite archive unexpectedly contains Node runtime entries: " + nodeRuntimeEntries.join(", "));

  const nativeFiles = [...files.keys()].filter((name) => name.startsWith("native/") && name.endsWith(".node"));
  assert(nativeFiles.length > 0, "Portable archive does not contain any native addon");
  const candidates = nativeCandidates(process.platform, process.arch);
  if (candidates.length > 0) {
    assert(
      candidates.some((suffix) => nativeFiles.some((name) => name.includes(suffix))),
      "Portable archive has no native addon for " + process.platform + "/" + process.arch +
      "; found: " + nativeFiles.join(", "),
    );
  }

  const hostFiles = [...files.keys()].filter(
    (name) => name.startsWith("hosts/webview2/") && name.endsWith(".exe"),
  );
  for (const hostName of hostFiles) {
    const hostImage = readFileSync(join(extract, hostName));
    const peOffset = hostImage.length >= 0x40 ? hostImage.readUInt32LE(0x3c) : -1;
    assert(peOffset >= 0 && hostImage.toString("ascii", peOffset, peOffset + 4) === "PE\0\0",
      hostName + " is not a valid PE image");
    const machine = hostImage.readUInt16LE(peOffset + 4);
    const expectedMachine = hostName.includes("/win-x86/") ? 0x014c
      : hostName.includes("/win-x64/") ? 0x8664 : null;
    if (expectedMachine !== null) {
      assert(machine === expectedMachine,
        hostName + " has PE machine 0x" + machine.toString(16) +
        ", expected 0x" + expectedMachine.toString(16));
    }
    for (const forbidden of ["libwinpthread-1.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll"]) {
      assert(
        !hostImage.includes(Buffer.from(forbidden, "ascii")),
        hostName + " must not depend on the MSYS2 runtime " + forbidden,
      );
    }
  }
  if (options.requireWebView2) {
    assert(hostFiles.includes("hosts/webview2/win-x86/webview2-host.exe"), "x86 WebView2 host is missing");
    assert(hostFiles.includes("hosts/webview2/win-x64/webview2-host.exe"), "x64 WebView2 host is missing");
  }
  const bootstrapper = "tools/MicrosoftEdgeWebView2Setup.exe";
  const bootstrapperHash = bootstrapper + ".sha256";
  if (names.has(bootstrapper)) {
    assert(names.has(bootstrapperHash), "WebView2 Bootstrapper hash sidecar is missing");
    const actualHash = createHash("sha256").update(readFileSync(join(extract, bootstrapper))).digest("hex");
    const sidecar = readFileSync(join(extract, bootstrapperHash), "utf8").trim();
    assert(new RegExp("^" + actualHash + "\\s+MicrosoftEdgeWebView2Setup\\.exe$").test(sidecar),
      "WebView2 Bootstrapper SHA-256 sidecar does not match the packaged installer");
  } else {
    assert(!names.has(bootstrapperHash), "WebView2 Bootstrapper hash sidecar exists without the installer");
  }
  return { files, nativeFiles, hostFiles };
}

function launcherFor(extract, preferScript = false) {
  if (process.platform === "win32") {
    if (preferScript) return join(extract, "codex-proxy.cmd");
    const exe = join(extract, "codex-proxy.exe");
    return existsSync(exe) ? exe : join(extract, "codex-proxy.cmd");
  }
  return join(extract, "codex-proxy.sh");
}

function assertCommandSucceeded(result, description) {
  assert(!result.error, description + " could not start: " + (result.error?.message ?? String(result.error)));
  assert(result.status === 0, description + " failed with exit " + result.status + ":\n" + result.output);
}

function readPeSubsystem(file) {
  const image = readFileSync(file);
  assert(image.length >= 0x40, "Windows launcher is too small to be a PE image");
  const peOffset = image.readUInt32LE(0x3c);
  assert(image.toString("ascii", peOffset, peOffset + 4) === "PE\0\0", "Windows launcher has no PE signature");
  // IMAGE_OPTIONAL_HEADER.Subsystem is 68 bytes into both PE32 and PE32+.
  return image.readUInt16LE(peOffset + 24 + 68);
}

function launcherSmoke(extract, outside, options) {
  const env = testEnvironment({ CODEX_PROXY_NODE: process.execPath });
  if (process.platform === "win32") {
    const exe = join(extract, "codex-proxy.exe");
    if (options.requireWindowsExe) assert(existsSync(exe), "Windows native launcher is required but missing");
    if (existsSync(exe)) {
      assert(readPeSubsystem(exe) === 2, "codex-proxy.exe must use the Windows GUI subsystem");
      const result = runSync(exe, ["--help"], { cwd: outside, env });
      assertCommandSucceeded(result, "codex-proxy.exe --help");
      assert(result.output.includes("Usage:"), "codex-proxy.exe --help did not print usage");
    }
    const cmd = join(extract, "codex-proxy.cmd");
    const result = runSync(cmd, ["--help"], { cwd: outside, env, shell: true });
    assertCommandSucceeded(result, "codex-proxy.cmd --help");
    assert(result.output.includes("Usage:"), "codex-proxy.cmd --help did not print usage");
  } else {
    const launcher = join(extract, "codex-proxy.sh");
    const result = runSync(launcher, ["--help"], { cwd: outside, env });
    assertCommandSucceeded(result, "./codex-proxy.sh --help");
    assert(result.output.includes("Usage:"), "codex-proxy.sh --help did not print usage");
  }
}

function noNodeSmoke(extract, outside, tempRoot) {
  const missingNode = join(tempRoot, "missing-node");
  const env = testEnvironment({ CODEX_PROXY_NODE: "" });
  if (process.platform === "win32") {
    env.SystemRoot = join(tempRoot, "no-system-root");
    const result = runSync(
      join(extract, "codex-proxy.cmd"),
      ["-n", missingNode, "--mode=server"],
      { cwd: outside, env, shell: true },
    );
    assert(
      result.output.includes("This portable package does not include Node.js."),
      "Windows no-Node guidance is missing",
    );
  } else {
    const result = runSync(
      join(extract, "codex-proxy.sh"),
      ["-n", missingNode, "--mode=server"],
      { cwd: outside, env },
    );
    assert(
      result.status === 127,
      "POSIX no-Node launcher should exit 127, got " + result.status + ":\n" + result.output,
    );
    assert(result.output.includes("This package does not include Node.js."), "POSIX no-Node guidance is missing");
  }
}

function waitForClose(child, timeoutMs = 3_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveClose) => {
    const timer = setTimeout(resolveClose, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
}

async function terminate(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
  } else {
    child.kill("SIGTERM");
  }
  await waitForClose(child, 5_000);
  if (child.exitCode === null) {
    child.kill();
    await waitForClose(child, 1_000);
  }
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) => probe.close((error) => error ? rejectClose(error) : resolveClose()));
  assert(port, "Could not reserve a local test port");
  return port;
}

function startPortableProcess(extract, outside, args, env, preferScript = false, directApp = false, launcherOverride = null) {
  const launcher = directApp ? process.execPath : launcherOverride ?? launcherFor(extract, preferScript);
  const isCmd = process.platform === "win32" && launcher.endsWith(".cmd");
  const processArgs = directApp ? [join(extract, "app", "server.mjs"), ...args] : args;
  const command = isCmd ? (process.env.ComSpec ?? "cmd.exe") : launcher;
  const commandArgs = isCmd ? ["/d", "/c", "call", launcher, ...processArgs] : processArgs;
  const child = spawn(command, commandArgs, {
    cwd: outside,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const append = (chunk) => { output += chunk.toString(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, getOutput: () => output };
}

async function waitForReady(processHandle, description) {
  const { child, getOutput } = processHandle;
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => finish(rejectReady, new Error(
      description + " did not become ready:\n" + getOutput(),
    )), 20_000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const check = () => {
      const match = /CODEX_PROXY_READY=(http:\/\/[^\s]+\/)/.exec(getOutput());
      if (match) finish(resolveReady, match[1]);
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("error", (error) => finish(rejectReady, error));
    child.once("close", (code) => {
      if (code !== 0) finish(rejectReady, new Error(
        description + " exited " + code + ":\n" + getOutput(),
      ));
      else finish(rejectReady, new Error(
        description + " exited before becoming ready:\n" + getOutput(),
      ));
    });
    check();
  });
}

async function waitForHttpReady(processHandle, port, description) {
  const { child, getOutput } = processHandle;
  const url = "http://127.0.0.1:" + port + "/";
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(description + " exited " + child.exitCode + ":\n" + getOutput());
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.arrayBuffer();
      if (response.ok) return url;
      lastError = new Error("HTTP " + response.status + " (" + body.byteLength + " bytes)");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    description + " did not become ready at " + url + ": " + (lastError?.message ?? "unknown error") +
    "\n" + getOutput(),
  );
}

async function serverSmoke(extract, outside) {
  const port = await findFreePort();
  const processHandle = startPortableProcess(
    extract,
    extract,
    ["-p", "--mode=server", "--host=127.0.0.1", "--port=" + port],
    testEnvironment({ CODEX_PROXY_NODE: process.execPath }),
    false,
    true,
  );
  try {
    const url = await waitForReady(processHandle, "portable server");
    const response = await fetch(url);
    assert(response.status === 200, "Portable server returned HTTP " + response.status + ", expected 200");
    const diagnostics = await fetch(new URL("debug/diagnostics", url));
    assert(diagnostics.ok, "Portable diagnostics returned HTTP " + diagnostics.status);
    const diagnosticsData = await diagnostics.json();
    assert(
      canonicalPath(diagnosticsData.paths?.data) === canonicalPath(resolve(extract, "data")),
      "--portable did not use package data directory; got " + diagnosticsData.paths?.data,
    );
  } finally {
    await terminate(processHandle.child);
  }
}

async function launcherRuntimeSmoke(extract, outside, options) {
  const launchers = [];
  if (process.platform === "win32") {
    launchers.push({ path: join(extract, "codex-proxy.cmd"), label: "codex-proxy.cmd" });
    if (options.testNativeLauncher) {
      const nativePath = join(extract, "codex-proxy.exe");
      assert(existsSync(nativePath), "Native launcher runtime test requested but codex-proxy.exe is missing");
      launchers.push({ path: nativePath, label: "codex-proxy.exe" });
    }
  } else {
    launchers.push({ path: join(extract, "codex-proxy.sh"), label: "codex-proxy.sh" });
  }

  for (const launcher of launchers) {
    const port = await findFreePort();
    const processHandle = startPortableProcess(
      extract,
      outside,
      ["-p", "-m", "server", "-H", "127.0.0.1", "-P", String(port)],
      testEnvironment({ CODEX_PROXY_NODE: process.execPath }),
      launcher.path.endsWith(".cmd"),
      false,
      launcher.path,
    );
    try {
      const url = launcher.path.endsWith(".exe")
        ? await waitForHttpReady(processHandle, port, launcher.label + " server")
        : await waitForReady(processHandle, launcher.label + " server");
      const response = await fetch(url);
      assert(response.status === 200, launcher.label + " returned HTTP " + response.status + ", expected 200");
      const diagnostics = await fetch(new URL("debug/diagnostics", url));
      assert(diagnostics.ok, launcher.label + " diagnostics returned HTTP " + diagnostics.status);
      const diagnosticsData = await diagnostics.json();
      assert(
        canonicalPath(diagnosticsData.paths?.data) === canonicalPath(resolve(extract, "data")),
        launcher.label + " did not resolve package-local data after an unrelated cwd; got " + diagnosticsData.paths?.data,
      );
    } finally {
      await terminate(processHandle.child);
    }
  }
}

async function defaultDataModeSmoke(extract, outside, tempRoot) {
  const port = await findFreePort();
  const userDataBase = join(tempRoot, "default-user-data-root");
  let userData;
  const environment = { CODEX_PROXY_NODE: process.execPath };
  if (process.platform === "win32") {
    environment.APPDATA = userDataBase;
    userData = join(userDataBase, "@codex-proxy", "electron", "data");
  } else if (process.platform === "darwin") {
    environment.HOME = userDataBase;
    userData = join(userDataBase, "Library", "Application Support", "@codex-proxy", "electron", "data");
  } else {
    environment.XDG_CONFIG_HOME = userDataBase;
    userData = join(userDataBase, "@codex-proxy", "electron", "data");
  }
  const env = testEnvironment(environment);
  delete env.CODEX_PROXY_DATA_DIR;
  const processHandle = startPortableProcess(
    extract,
    outside,
    ["--mode=server", "--host=127.0.0.1", "--port=" + port],
    env,
    false,
    true,
  );
  try {
    const url = await waitForReady(processHandle, "default data mode");
    const diagnostics = await fetch(new URL("debug/diagnostics", url));
    assert(diagnostics.ok, "Default data mode diagnostics returned HTTP " + diagnostics.status);
    const diagnosticsData = await diagnostics.json();
    assert(
      canonicalPath(diagnosticsData.paths?.data) === canonicalPath(resolve(userData)),
      "default mode did not use the user data directory; got " + diagnosticsData.paths?.data,
    );
    assert(
      !existsSync(join(extract, "data", "local.yaml")),
      "default mode unexpectedly created package-local data/local.yaml",
    );
  } finally {
    await terminate(processHandle.child);
  }
}

async function browserSmoke(extract, outside, tempRoot) {
  if (process.platform === "win32") return;
  const port = await findFreePort();
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const capture = join(tempRoot, "opened-url.txt");
  const browserBin = join(tempRoot, "browser-bin");
  const stub = join(browserBin, command);
  mkdirSync(browserBin, { recursive: true });
  writeFileSync(stub, "#!/bin/sh\nprintf '%s' \"$1\" > \"$PORTABLE_TEST_OPENED_URL\"\n");
  chmodSync(stub, 0o755);
  const processHandle = startPortableProcess(
    extract,
    outside,
    ["--portable", "--mode=auto", "--host=127.0.0.1", "--port=" + port],
    testEnvironment({
      CODEX_PROXY_NODE: process.execPath,
      PATH: browserBin + delimiter + (process.env.PATH ?? ""),
      PORTABLE_TEST_OPENED_URL: capture,
    }),
  );
  try {
    const url = await waitForReady(processHandle, "portable auto mode");
    const deadline = Date.now() + 5_000;
    while (!existsSync(capture) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert(existsSync(capture), "Portable auto mode did not invoke " + command);
    assert(
      readFileSync(capture, "utf8") === url,
      "Portable auto mode opened the wrong URL; expected " + url,
    );
  } finally {
    await terminate(processHandle.child);
  }
}

async function cleanupTempRoot(tempRoot) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || attempt === 19) {
        console.warn("[portable-test] Could not remove temporary test directory: " + tempRoot);
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert(existsSync(options.archive), "Archive not found: " + options.archive);
  const tempRoot = mkdtempSync(join(tmpdir(), "codex-proxy-portable-test-"));
  const extract = join(tempRoot, "package");
  const outside = join(tempRoot, "unrelated-cwd");
  mkdirSync(extract, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    const entries = extractArchive(options.archive, extract);
    const summary = archiveContract(entries, extract, options);
    launcherSmoke(extract, outside, options);
    noNodeSmoke(extract, outside, tempRoot);
    if (!options.skipRuntime) {
      await defaultDataModeSmoke(extract, outside, tempRoot);
      await launcherRuntimeSmoke(extract, outside, options);
      await serverSmoke(extract, outside);
      await browserSmoke(extract, outside, tempRoot);
      if (process.platform !== "win32") {
        const result = runSync(
          process.execPath,
          [join(extract, "app", "server.mjs"), "--portable", "--mode=webview2", "--port=0"],
          { cwd: outside },
        );
        assert(result.status !== 0, "WebView2 mode unexpectedly succeeded on a non-Windows host");
        assert(
          result.output.includes("WebView2 mode is only available on Windows"),
          "Non-Windows WebView2 error is missing",
        );
      }
    }
    console.log(
      "[portable-test] PASS platform=" + process.platform +
      " arch=" + process.arch +
      " native=" + summary.nativeFiles.length +
      " webview2-hosts=" + summary.hostFiles.length,
    );
  } finally {
    if (!options.keep) await cleanupTempRoot(tempRoot);
    else console.log("[portable-test] kept test directory: " + tempRoot);
  }
}

main().catch((error) => {
  console.error("[portable-test] FAIL: " + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
