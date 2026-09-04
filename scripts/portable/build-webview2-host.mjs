import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");

function existingPath(...candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function defaultMsys2Root() {
  const runnerMsys2 = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2", "msys64")
    : null;
  const runnerMsys2Root = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2")
    : null;
  return existingPath(
    process.env.MSYS2_ROOT,
    "D:\\DevTools\\Tools\\msys64",
    runnerMsys2,
    runnerMsys2Root,
    "C:\\msys64",
  ) ?? process.env.MSYS2_ROOT ?? "C:\\msys64";
}

function parseArgs(argv) {
  const options = {
    arch: process.env.WEBVIEW2_HOST_ARCH ?? "x64",
    msys2Root: defaultMsys2Root(),
    includeDir: process.env.WEBVIEW2_INCLUDE_DIR ?? null,
    out: resolve(ROOT, "portable-release", "hosts", "webview2", "webview2-host.exe"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--arch", "--msys2", "--include-dir", "--out"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--arch") options.arch = value;
      else if (arg === "--msys2") options.msys2Root = resolve(value);
      else if (arg === "--include-dir") options.includeDir = resolve(value);
      else options.out = resolve(value);
      continue;
    }
    if (arg.startsWith("--arch=")) options.arch = arg.slice("--arch=".length);
    else if (arg.startsWith("--msys2=")) options.msys2Root = resolve(arg.slice("--msys2=".length));
    else if (arg.startsWith("--include-dir=")) options.includeDir = resolve(arg.slice("--include-dir=".length));
    else if (arg.startsWith("--out=")) options.out = resolve(arg.slice("--out=".length));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["x86", "x64"].includes(options.arch)) {
    throw new Error(`Unsupported WebView2 host architecture: ${options.arch}; use x86 or x64`);
  }
  return options;
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`${description} not found: ${path}`);
}

function msysPath(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveToolchain(options) {
  const root = options.msys2Root;
  const compiler = options.arch === "x86"
    ? existingPath(join(root, "mingw32", "bin", "g++.exe"))
    : existingPath(
      join(root, "ucrt64", "bin", "g++.exe"),
      join(root, "mingw64", "bin", "g++.exe"),
    );
  if (!compiler) {
    throw new Error(
      `MinGW C++ compiler not found under ${root}; install the ${options.arch} MSYS2 toolchain`,
    );
  }

  const includeDir = options.includeDir ?? [
    join(root, "ucrt64", "include"),
    join(root, "mingw64", "include"),
    join(root, "mingw32", "include"),
  ].find((candidate) =>
    existsSync(join(candidate, "webview", "webview.h")) &&
    existsSync(join(candidate, "WebView2.h"))) ?? null;
  if (!includeDir) throw new Error(`WebView2 include directory not found under ${root}`);
  requirePath(join(includeDir, "webview", "webview.h"), "webview/webview.h");
  requirePath(join(includeDir, "WebView2.h"), "WebView2.h");
  const resourceCompiler = existingPath(
    join(dirname(compiler), "windres.exe"),
    join(root, "mingw32", "bin", "windres.exe"),
    join(root, "mingw64", "bin", "windres.exe"),
  );
  if (!resourceCompiler) throw new Error(`MinGW resource compiler not found under ${root}`);
  return { compiler, includeDir, resourceCompiler };
}

function stageWebView2HeadersForX86(includeDir, outputDir) {
  const staged = join(outputDir, ".webview2-headers-x86");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(join(staged, "webview"), { recursive: true });
  cpSync(join(includeDir, "webview", "webview.h"), join(staged, "webview", "webview.h"));
  cpSync(join(includeDir, "WebView2.h"), join(staged, "WebView2.h"));
  const environmentOptions = join(includeDir, "WebView2EnvironmentOptions.h");
  if (existsSync(environmentOptions)) {
    cpSync(environmentOptions, join(staged, "WebView2EnvironmentOptions.h"));
  }
  return staged;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const toolchain = resolveToolchain(options);
  const source = resolve(SCRIPT_DIR, "webview2-host.cpp");
  const resource = resolve(SCRIPT_DIR, "codex-proxy.rc");
  requirePath(source, "WebView2 host source");
  requirePath(resource, "WebView2 host icon resource");
  const bash = join(options.msys2Root, "usr", "bin", "bash.exe");
  requirePath(bash, "MSYS2 bash");
  mkdirSync(dirname(options.out), { recursive: true });

  // MSYS2's native compiler accepts POSIX paths reliably through its bash
  // launcher. Direct CreateProcess invocation can treat a Windows -I path as
  // a drive-relative path and fail without diagnostics.
  const resourceObject = join(dirname(options.out), ".codex-proxy-icon.o");
  const compilerBin = dirname(toolchain.compiler);
  const environment = `export PATH=${shellQuote(msysPath(compilerBin))}:/usr/bin:$PATH; `;
  const resourceCommand = [
    shellQuote(msysPath(toolchain.resourceCompiler)),
    "-I", shellQuote(msysPath(SCRIPT_DIR)),
    shellQuote(msysPath(resource)),
    "-O", "coff",
    "-o", shellQuote(msysPath(resourceObject)),
  ].join(" ");
  const resourceResult = spawnSync(bash, ["-lc", environment + resourceCommand], {
    cwd: ROOT,
    windowsHide: true,
  });
  if (resourceResult.error) throw resourceResult.error;
  if (resourceResult.status !== 0 || !existsSync(resourceObject)) {
    throw new Error(`WebView2 host icon build failed with exit code ${resourceResult.status}`);
  }

  let compileIncludeDir = toolchain.includeDir;
  let stagedIncludeDir = null;
  try {
    // MSYS2 currently provides the WebView2 headers in UCRT64 but the x86
    // compiler is MINGW32. Copy only the WebView2 headers into a private
    // include directory so mingw32 keeps using its own Windows/CRT headers.
    if (options.arch === "x86") {
      stagedIncludeDir = stageWebView2HeadersForX86(toolchain.includeDir, dirname(options.out));
      compileIncludeDir = stagedIncludeDir;
    }
    const command = [
      shellQuote(msysPath(toolchain.compiler)),
      shellQuote(msysPath(source)),
      "-std=c++14",
      "-O2",
      "-s",
      "-mwindows",
      "-municode",
      "-static",
      "-static-libgcc",
      "-static-libstdc++",
      "-I", shellQuote(msysPath(compileIncludeDir)),
      shellQuote(msysPath(resourceObject)),
      "-luser32",
      "-lshell32",
      "-lole32",
      "-loleaut32",
      "-lshlwapi",
      "-lversion",
      "-luuid",
      "-o", shellQuote(msysPath(options.out)),
    ].join(" ");
    const result = spawnSync(bash, ["-lc", environment + command], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`WebView2 host build failed with exit code ${result.status}`);
  } finally {
    rmSync(resourceObject, { force: true });
    if (stagedIncludeDir) rmSync(stagedIncludeDir, { recursive: true, force: true });
  }
  requirePath(options.out, "WebView2 host output");
  console.log(`[webview2] host: ${options.out}`);
  console.log(`[webview2] arch: ${options.arch}`);
  console.log(`[webview2] compiler: ${toolchain.compiler}`);
  console.log(`[webview2] headers: ${compileIncludeDir}`);
}

main();
