import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_OUT = resolve(ROOT, "portable-release");
const BUNDLE = resolve(ROOT, "packages/electron/dist-electron/server.mjs");

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    version: process.env.PORTABLE_VERSION ?? null,
    webview2Host: process.env.PORTABLE_WEBVIEW2_HOST ?? null,
    webview2HostX86: process.env.PORTABLE_WEBVIEW2_HOST_X86 ?? null,
    webview2HostX64: process.env.PORTABLE_WEBVIEW2_HOST_X64 ?? null,
    webview2HostArm64: process.env.PORTABLE_WEBVIEW2_HOST_ARM64 ?? null,
    webview2Bootstrapper: process.env.PORTABLE_WEBVIEW2_BOOTSTRAPPER ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ([
      "--out", "--version", "--webview2-host", "--webview2-host-x86",
      "--webview2-host-x64", "--webview2-host-arm64", "--webview2-bootstrapper",
    ].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--out") options.out = resolve(value);
      else if (arg === "--version") options.version = value;
      else if (arg === "--webview2-host") options.webview2Host = resolve(value);
      else if (arg === "--webview2-host-x86") options.webview2HostX86 = resolve(value);
      else if (arg === "--webview2-host-x64") options.webview2HostX64 = resolve(value);
      else if (arg === "--webview2-host-arm64") options.webview2HostArm64 = resolve(value);
      else options.webview2Bootstrapper = resolve(value);
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg.startsWith("--webview2-host=")) {
      options.webview2Host = resolve(arg.slice("--webview2-host=".length));
    } else if (arg.startsWith("--webview2-host-x86=")) {
      options.webview2HostX86 = resolve(arg.slice("--webview2-host-x86=".length));
    } else if (arg.startsWith("--webview2-host-x64=")) {
      options.webview2HostX64 = resolve(arg.slice("--webview2-host-x64=".length));
    } else if (arg.startsWith("--webview2-host-arm64=")) {
      options.webview2HostArm64 = resolve(arg.slice("--webview2-host-arm64=".length));
    } else if (arg.startsWith("--webview2-bootstrapper=")) {
      options.webview2Bootstrapper = resolve(arg.slice("--webview2-bootstrapper=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`${description} not found: ${path}`);
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

function copyDirectory(source, destination) {
  requirePath(source, "Required directory");
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function copyRuntimeNative(source, destination) {
  requirePath(source, "native source directory");
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    if (name === "index.js" || name === "index.d.ts" || name.endsWith(".node")) {
      cpSync(sourcePath, join(destination, name), { force: true });
    }
  }
  // The generated napi-rs loader is CommonJS. The portable package is often
  // extracted below a repository or application with `type: module`; keep a
  // local package boundary so Node does not reinterpret native/index.js as ESM.
  writeFileSync(join(destination, "package.json"), '{"type":"commonjs"}\n');
}

function existingPath(...candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function msysPath(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function msys2Roots() {
  const runnerMsys2 = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2", "msys64")
    : null;
  const runnerMsys2Root = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, "setup-msys2")
    : null;
  return [
    process.env.MSYS2_ROOT,
    process.env.PORTABLE_MSYS2_ROOT,
    "D:\\DevTools\\Tools\\msys64",
    runnerMsys2,
    runnerMsys2Root,
    "C:\\msys64",
  ].filter(Boolean);
}

function resolveMsys2LauncherToolchain() {
  for (const root of msys2Roots()) {
    const compiler = existingPath(join(root, "mingw32", "bin", "gcc.exe"));
    const bash = existingPath(join(root, "usr", "bin", "bash.exe"));
    const resourceCompiler = compiler && existingPath(
      join(dirname(compiler), "windres.exe"),
      join(root, "mingw32", "bin", "windres.exe"),
      join(root, "mingw64", "bin", "windres.exe"),
    );
    if (compiler && bash && resourceCompiler) return { compiler, bash, resourceCompiler };
  }
  return null;
}

function tryBuildWindowsLauncher(destination) {
  if (process.platform !== "win32") {
    return false;
  }

  const source = resolve(SCRIPT_DIR, "win-launcher.c");
  const resource = resolve(SCRIPT_DIR, "codex-proxy.rc");
  const output = join(destination, "codex-proxy.exe");
  const requireExe = process.env.PORTABLE_REQUIRE_WINDOWS_EXE === "1";
  const toolchain = resolveMsys2LauncherToolchain();
  if (!toolchain) {
    const message = "MSYS2 MinGW x86 compiler/resource compiler was not found; using .cmd fallback";
    if (requireExe) throw new Error(`PORTABLE_REQUIRE_WINDOWS_EXE=1 but ${message}`);
    console.warn(`[portable] ${message}`);
    return false;
  }
  requirePath(source, "Windows launcher source");
  requirePath(resource, "Windows launcher icon resource");

  // Build through MSYS2's bash so Windows paths are converted consistently.
  // The x86 launcher is intentionally architecture-neutral at the package
  // boundary: Windows x64 and Windows on ARM64 can run it through their
  // compatibility layers, while it dispatches to the user's Node binary.
  const resourceObject = join(destination, ".codex-proxy-icon.o");
  const compilerBin = dirname(toolchain.compiler);
  const environment = `export PATH=${shellQuote(msysPath(compilerBin))}:/usr/bin:$PATH; `;
  const resourceCommand = [
    shellQuote(msysPath(toolchain.resourceCompiler)),
    "-I", shellQuote(msysPath(SCRIPT_DIR)),
    shellQuote(msysPath(resource)),
    "-O", "coff",
    "-o", shellQuote(msysPath(resourceObject)),
  ].join(" ");
  const resourceResult = spawnSync(toolchain.bash, ["-lc", environment + resourceCommand], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (resourceResult.error || resourceResult.status !== 0 || !existsSync(resourceObject)) {
    rmSync(resourceObject, { force: true });
    const detail = resourceResult.error?.message ?? resourceResult.stderr ?? resourceResult.stdout ?? "unknown error";
    if (requireExe) throw new Error(`MSYS2 Windows launcher icon build failed: ${detail}`);
    console.warn(`[portable] MSYS2 Windows launcher icon build failed: ${detail}; using .cmd fallback`);
    return false;
  }

  const command = [
    shellQuote(msysPath(toolchain.compiler)),
    "-O2",
    "-s",
    "-municode",
    "-mwindows",
    "-static",
    "-static-libgcc",
    "-static-libstdc++",
    shellQuote(msysPath(source)),
    shellQuote(msysPath(resourceObject)),
    "-luser32",
    "-lshell32",
    "-o", shellQuote(msysPath(output)),
  ].join(" ");
  const result = spawnSync(toolchain.bash, [
    "-lc",
    environment + command,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  rmSync(resourceObject, { force: true });
  if (result.error) {
    if (requireExe) throw result.error;
    console.warn(`[portable] MSYS2 launcher build could not start: ${result.error.message}; using .cmd fallback`);
    return false;
  }
  if (result.status !== 0) {
    if (requireExe) throw new Error(`MSYS2 Windows launcher build failed:\n${result.stdout}\n${result.stderr}`);
    console.warn("[portable] MSYS2 launcher build failed; using .cmd fallback");
    return false;
  }
  if (!existsSync(output)) {
    if (requireExe) throw new Error(`MSYS2 launcher build succeeded but output was not created: ${output}`);
    console.warn("[portable] MSYS2 launcher output was not created; using .cmd fallback");
    return false;
  }
  return true;
}

function copyWebView2Host(source, destination, architecture = null) {
  const target = join(destination, "hosts", "webview2", ...(architecture ? [`win-${architecture}`] : []));
  mkdirSync(target, { recursive: true });
  if (!source) {
    return false;
  }
  requirePath(source, "WebView2 host");
  const stat = readFileSync(source);
  writeFileSync(join(target, "webview2-host.exe"), stat);
  return true;
}

function copyWebView2Hosts(options, destination) {
  const hosts = [
    [options.webview2Host, null],
    [options.webview2HostX86, "x86"],
    [options.webview2HostX64, "x64"],
    [options.webview2HostArm64, "arm64"],
  ];
  const included = hosts
    .filter(([source]) => source)
    .map(([source, architecture]) => {
      copyWebView2Host(source, destination, architecture);
      return architecture ?? "default";
    });
  const target = join(destination, "hosts", "webview2");
  mkdirSync(target, { recursive: true });
  if (included.length === 0) {
    writeFileSync(join(target, "README.txt"),
      "WebView2 host is not included in this development build.\r\n" +
      "Provide --webview2-host-x86/--webview2-host-x64 when packaging a host executable.\r\n");
  }
  return included;
}

function copyWebView2Bootstrapper(source, destination) {
  if (!source) return null;
  requirePath(source, "WebView2 Evergreen Bootstrapper");
  const target = join(destination, "tools", "MicrosoftEdgeWebView2Setup.exe");
  mkdirSync(dirname(target), { recursive: true });
  const content = readFileSync(source);
  const sha256 = createHash("sha256").update(content).digest("hex");
  writeFileSync(target, content);
  writeFileSync(`${target}.sha256`, `${sha256}  MicrosoftEdgeWebView2Setup.exe\r\n`);
  return { file: "tools/MicrosoftEdgeWebView2Setup.exe", bytes: content.length, sha256 };
}

function normalizeTarModes(rawTar) {
  const content = readFileSync(rawTar);
  let normalized = 0;
  for (let offset = 0; offset + 512 <= content.length; offset += 512) {
    const field = (start, length) => content.subarray(offset + start, offset + start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const fullName = `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//, "");
    if (fullName !== "codex-proxy.sh" && !fullName.endsWith("/codex-proxy.sh")) continue;

    // Windows tar implementations commonly write all regular files as 0666,
    // even when chmodSync() set the executable bit in the staging directory.
    // Rewrite the POSIX mode and checksum in the raw ustar header so the bit
    // survives extraction on Linux and macOS.
    content.write("0000755\0 ", offset + 100, 8, "ascii");
    content.fill(0x20, offset + 148, offset + 156);
    let checksum = 0;
    for (let i = offset; i < offset + 512; i += 1) checksum += content[i];
    content.write(`${checksum.toString(8).padStart(6, "0")}\0 `, offset + 148, 8, "ascii");
    normalized += 1;
  }
  if (normalized === 0) throw new Error("The raw tar archive did not contain codex-proxy.sh");
  writeFileSync(rawTar, content);
}

function createRawTar(stage, rawTar) {
  // Python's tarfile lets us set POSIX modes explicitly and behaves the same
  // on Windows, macOS, and Linux. It is already an optional packaging
  // dependency for the XZ fallback, so do not add an npm dependency here.
  const pythonScript = [
    "import sys, tarfile",
    "stage, output = sys.argv[1:3]",
    "def normalize(info):",
    "    normalized = info.name.replace('\\\\', '/')",
    "    if normalized == 'codex-proxy.sh' or normalized.endswith('/codex-proxy.sh'):",
    "        info.mode = 0o755",
    "    return info",
    "with tarfile.open(output, 'w') as archive:",
    "    archive.add(stage, arcname='.', recursive=True, filter=normalize)",
  ].join("\n");
  for (const python of ["python", "python3"]) {
    if (!commandExists(python)) continue;
    const result = spawnSync(python, ["-c", pythonScript, stage, rawTar], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return "python-tarfile";
    console.warn(`[portable] ${python} tar creation failed: ${result.stderr || result.stdout}`);
  }

  execFileSync("tar", ["-cf", rawTar, "-C", stage, "."], { stdio: "inherit" });
  normalizeTarModes(rawTar);
  return "tar+normalized-modes";
}

function compressTarXz(stage, archive, tempRoot) {
  const rawTar = join(tempRoot, "codex-proxy.tar");
  rmSync(rawTar, { force: true });
  rmSync(`${rawTar}.xz`, { force: true });
  try {
    const tarMethod = createRawTar(stage, rawTar);

    if (commandExists("xz")) {
      execFileSync("xz", ["-9", "-f", rawTar], { stdio: "inherit" });
      renameSync(`${rawTar}.xz`, archive);
      return `${tarMethod}+xz`;
    }

    // Windows Developer/PyManager installations often have Python but no xz.
    // Python's standard library provides the same XZ/LZMA container without a
    // new npm dependency. This is a packaging fallback, not a runtime dependency.
    for (const python of ["python", "python3"]) {
      if (!commandExists(python)) continue;
      const result = spawnSync(python, ["-c", [
        "import lzma, shutil, sys",
        "with open(sys.argv[1], 'rb') as source, lzma.open(sys.argv[2], 'wb', preset=9, format=lzma.FORMAT_XZ) as target:",
        "    shutil.copyfileobj(source, target)",
      ].join("\n"), rawTar, archive], { encoding: "utf8", windowsHide: true });
      if (result.status === 0) return `${tarMethod}+python-lzma`;
      console.warn(`[portable] ${python} XZ fallback failed: ${result.stderr || result.stdout}`);
    }

    throw new Error("No XZ compressor found. Install xz, 7-Zip, or Python 3 to create the tar.xz archive.");
  } finally {
    rmSync(rawTar, { force: true });
    rmSync(`${rawTar}.xz`, { force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootPackage = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const version = options.version ?? rootPackage.version;
  requirePath(BUNDLE, "server bundle; run the Electron esbuild step first");
  requirePath(resolve(ROOT, "public", "index.html"), "built web assets; run npm run build first");

  const stage = resolve(options.out, ".staging", "codex-proxy");
  const archive = resolve(options.out, `codex-proxy-${version}-no-node-lite-all-platforms.tar.xz`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(options.out, { recursive: true });

  const app = join(stage, "app");
  mkdirSync(app, { recursive: true });
  cpSync(BUNDLE, join(app, "server-bundle.mjs"));
  cpSync(resolve(SCRIPT_DIR, "server.mjs"), join(app, "server.mjs"));
  const webview2Hosts = copyWebView2Hosts(options, stage);
  const webview2Bootstrapper = copyWebView2Bootstrapper(options.webview2Bootstrapper, stage);
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    name: "codex-proxy-lite",
    version,
    bundledNode: false,
    minimumNodeMajor: 20,
    modes: ["server", "browser", "auto", "webview2"],
    webview2: {
      hostArchitectures: webview2Hosts,
      bootstrapper: webview2Bootstrapper,
      supportedWindows: "Windows 10 SAC 1709+ and supported Windows 10 LTSC/IoT/Server editions; Windows 11",
    },
  }, null, 2) + "\n");

  for (const directory of ["config", "public", "bin"]) {
    copyDirectory(resolve(ROOT, directory), join(stage, directory));
  }
  cpSync(resolve(SCRIPT_DIR, "THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
  mkdirSync(join(stage, "data"), { recursive: true });
  copyRuntimeNative(resolve(ROOT, "native"), join(stage, "native"));

  cpSync(resolve(SCRIPT_DIR, "codex-proxy.sh"), join(stage, "codex-proxy.sh"));
  chmodSync(join(stage, "codex-proxy.sh"), 0o755);
  const hasWindowsExe = tryBuildWindowsLauncher(stage);
  // Keep the script even when the native launcher is present. It is useful
  // for diagnostics, custom Node resolution, and environments where the EXE
  // cannot be started by policy or compatibility tooling.
  cpSync(resolve(SCRIPT_DIR, "codex-proxy.cmd"), join(stage, "codex-proxy.cmd"));

  rmSync(archive, { force: true });
  const compressor = compressTarXz(stage, archive, resolve(options.out, ".staging"));
  rmSync(resolve(options.out, ".staging"), { recursive: true, force: true });

  console.log(`[lite] archive: ${archive}`);
  console.log(`[lite] compression: ${compressor}`);
  console.log(`[lite] Windows launcher: ${hasWindowsExe ? "codex-proxy.exe (MSYS2 MinGW x86)" : "codex-proxy.cmd fallback"}`);
  console.log("[lite] Windows script fallback: codex-proxy.cmd (always included)");
  console.log(`[lite] WebView2 host: ${webview2Hosts.length ? webview2Hosts.join(", ") : "not included"}`);
  console.log(`[lite] WebView2 Bootstrapper: ${webview2Bootstrapper ? `${webview2Bootstrapper.bytes} bytes` : "not included"}`);
}

main();
