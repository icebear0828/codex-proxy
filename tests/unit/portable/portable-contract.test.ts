import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..", "..");
const PORTABLE = resolve(ROOT, "scripts", "portable");
const NATIVE_INDEX = resolve(ROOT, "native", "index.js");
const NATIVE_PACKAGE = resolve(ROOT, "native", "package.json");
const NATIVE_MUSL_TEST = resolve(ROOT, "scripts", "native", "test-linux-x64-musl.mjs");
const RELEASE_WORKFLOW = resolve(ROOT, ".github", "workflows", "release.yml");
const LITE_CI_WORKFLOW = resolve(ROOT, ".github", "workflows", "lite-ci.yml");

function read(name: string): string {
  return readFileSync(resolve(PORTABLE, name), "utf8");
}

describe("No-Node Lite distribution contract", () => {
  it("keeps the server entry as a wrapper around the existing bundle", () => {
    const source = read("server.mjs");
    expect(source).toContain('import("./server-bundle.mjs")');
    expect(source).toContain('launchMode === "browser"');
    expect(source).toContain('launchMode === "auto"');
    expect(source).toContain('launchMode === "webview2"');
    expect(source).toContain("--portable");
    expect(source).toContain('arg === "-p"');
    expect(source).toContain('"--mode", "-m"');
    expect(source).toContain('"--host", "-H"');
    expect(source).toContain('"--port", "-P"');
    expect(source).toContain('"--webview2-host", "-w"');
    expect(source).toContain("defaultUserDataDir");
    expect(source).toContain("CODEX_PROXY_FORCE_NO_WEBVIEW2");
    expect(source).toContain("embedded: false");
    expect(source).toContain("CODEX_PROXY_DATA_DIR");
    expect(source).toContain("CODEX_PROXY_READY=");
    expect(source).toContain("CODEX_PROXY_NATIVE_TRAY");
    expect(source).toContain("CODEX_PROXY_WEBVIEW2_HOST=");
    expect(source).toContain("server remains available");
    expect(source).toContain("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5");
    expect(source).toContain("MicrosoftEdgeWebView2Setup.exe");
    expect(source).toContain("falling back to the default browser");
    expect(source).toContain("Run the local WebView2 installer now?");
    expect(source).toContain("Download and run the official installer (~2 MB) now?");
  });

  it("resolves the POSIX launcher directory before starting Node", () => {
    const source = read("codex-proxy.sh");
    expect(source).toContain('dirname "$0"');
    expect(source).toContain('cd "$ROOT_DIR"');
    expect(source).toContain('"$ROOT_DIR/app/server.mjs"');
    expect(source).toContain("--mode=browser");
    expect(source).toContain("process.platform may remain win32");
    expect(source).toContain("mode_specified");
    expect(source).toContain("-m|-m=*");
    expect(source).toContain('"-n"');
    expect(source).toContain("--portable");
    expect(source).toContain("Node.js 20 or newer");
    expect(source).toContain("15 seconds");
    expect(source).toContain("node_help");
  });

  it("resolves the Windows launcher directory and supports a cmd fallback", () => {
    const source = read("codex-proxy.cmd");
    expect(source).toContain('pushd "%~dp0"');
    expect(source).toContain('"%CD%\\app\\server.mjs"');
    expect(source).toContain("choice.exe");
    expect(source).toContain("15");

    const nativeSource = read("win-launcher.c");
    expect(nativeSource).toContain("GetModuleFileNameW");
    expect(nativeSource).toContain("SetCurrentDirectoryW");
    expect(nativeSource).toContain("CreateProcessW");
    expect(nativeSource).toContain("Shell_NotifyIconW");
    expect(nativeSource).toContain("TrackPopupMenu");
    expect(nativeSource).toContain("WM_CONTEXTMENU");
    expect(nativeSource).toContain("LOWORD(lparam)");
    expect(nativeSource).toContain("TRAY_OPEN_DASHBOARD");
    expect(nativeSource).toContain("TRAY_QUIT");
    expect(nativeSource).toContain("TRAY_OPEN_RELEASES");
    expect(nativeSource).toContain("RELEASES_URL");
    expect(nativeSource).toContain("CODEX_PROXY_WEBVIEW2_HOST");
    expect(nativeSource).toContain("start_webview2_host");
    expect(nativeSource).toContain("IDI_APP_ICON");
    expect(nativeSource).toContain("EnumWindows");
    expect(nativeSource).toContain("AssignProcessToJobObject");
    expect(nativeSource).toContain("MessageBoxTimeoutW");
    expect(nativeSource).toContain("ShellExecuteW");
    expect(nativeSource).toContain("--mode=auto");
    expect(nativeSource).toContain("--portable");
    expect(nativeSource).toContain("--portable, -p");
    expect(nativeSource).toContain("--node-path, -n");
    expect(nativeSource).toContain("CreateMutexW");
    expect(nativeSource).toContain("FindWindowExW");
    expect(nativeSource).toContain("TRAY_ACTIVATE_INSTANCE");
  });

  it("packages only runtime native files and creates a zip archive", () => {
    const source = read("build-portable.mjs");
    expect(source).toContain('name === "index.js"');
    expect(source).toContain('name.endsWith(".node")');
    expect(source).toContain('"type":"commonjs"');
    expect(source).not.toContain('copyDirectory(resolve(ROOT, "native")');
    expect(source).toContain("zipfile.ZipFile");
    expect(source).toContain("compresslevel=9");
    expect(source).toContain("info.compress_type = zipfile.ZIP_DEFLATED");
    expect(source).toContain("0o755 << 16");
    expect(source).toContain('"--version"');
    expect(source).toContain("PORTABLE_VERSION");
    expect(source).toContain("WebView2 host is not included");
    expect(source).toContain("--webview2-host-x86");
    expect(source).toContain("--webview2-host-x64");
    expect(source).not.toContain("--webview2-bootstrapper");
    expect(source).toContain("no-node-lite-all-platforms.zip");
    expect(source).not.toContain(".tar.xz");
    expect(source).not.toContain("MicrosoftEdgeWebView2Setup");
    expect(source).toContain("PORTABLE_MSYS2_ROOT");
    expect(source).toContain("mingw32");
    expect(source).toContain("-static-libgcc");
    expect(source).toContain("-static-libstdc++");
    expect(source).toContain('"-mwindows"');
    expect(source).toContain("windres");
    expect(source).toContain("codex-proxy.rc");
    expect(source).toContain("-luser32");
    expect(source).toContain("-lshell32");
    expect(source).toContain('join(stage, "codex-proxy.cmd")');
    expect(source).toContain("always included");
    expect(source).toContain("createZip");
    expect(source).toContain("python-zipfile");
  });

  it("has a real archive-level portable test harness", () => {
    const source = readFileSync(resolve(PORTABLE, "test-portable.mjs"), "utf8");
    expect(source).toContain("--archive");
    expect(source).toContain("zipfile");
    expect(source).toContain("non-deflated file entries");
    expect(source).toContain("codex-proxy.sh is not executable");
    expect(source).toContain("CODEX_PROXY_READY=");
    expect(source).toContain("--portable");
    expect(source).toContain("--test-native-launcher");
    expect(source).toContain("expected 200");
    expect(source).toContain("launcherRuntimeSmoke");
    expect(source).toContain("waitForHttpReady");
    expect(source).toContain("canonicalPath");
    expect(source).toContain("codex-proxy-lite");
    expect(source).toContain("nodeRuntimeEntries");
    expect(source).toContain("must not bundle the WebView2 Bootstrapper installer");
    expect(source).toContain("0x8664");
    expect(source).toContain("default data mode");
    expect(source).toContain("This package does not include Node.js.");
    expect(source).toContain("WebView2 mode is only available on Windows");
    expect(source).toContain("process.arch");
    expect(source).toContain("--require-linux-x64-musl");
    expect(source).toContain("native/codex-tls.linux-x64-musl.node");
  });

  it("defines and exercises the Linux x64/arm64 musl native builds", () => {
    const nativePackage = JSON.parse(readFileSync(NATIVE_PACKAGE, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(nativePackage.scripts?.["build:linux-x64-musl"]).toBe(
      "napi build --platform --release --target x86_64-unknown-linux-musl --js false",
    );
    expect(nativePackage.scripts?.["build:linux-arm64-musl"]).toBe(
      "napi build --platform --release --target aarch64-unknown-linux-musl --js false",
    );

    const source = readFileSync(NATIVE_MUSL_TEST, "utf8");
    expect(source).toContain("codex-tls-musl-ok");
    expect(source).toContain("httpGet");
    // The test script runs inside the alpine container of each architecture,
    // so its ELF machine assertion must cover both EM_X86_64 and EM_AARCH64.
    expect(source).toContain("EM_X86_64");
    expect(source).toContain("EM_AARCH64");
  });

  it("covers the native dispatch targets supported by the runtime loader", () => {
    const source = readFileSync(NATIVE_INDEX, "utf8");
    for (const target of [
      "win32-x64-msvc",
      "win32-ia32-msvc",
      "win32-arm64-msvc",
      "darwin-x64",
      "darwin-arm64",
      "darwin-universal",
      "linux-x64-gnu",
      "linux-x64-musl",
      "linux-arm64-gnu",
      "linux-arm64-musl",
      "linux-arm-gnueabihf",
      "linux-arm-musleabihf",
      "linux-riscv64-gnu",
      "linux-riscv64-musl",
      "linux-s390x-gnu",
      "freebsd-x64",
    ]) {
      expect(source).toContain("codex-tls." + target + ".node");
    }
  });

  it("builds the WebView2 host through an MSYS2 MinGW compiler", () => {
    const source = read("build-webview2-host.mjs");
    const host = read("webview2-host.cpp");
    expect(source).toContain("D:\\\\DevTools\\\\Tools\\\\msys64");
    expect(source).toContain("setup-msys2");
    expect(source).toContain("runnerMsys2Root");
    expect(source.indexOf("runnerMsys2,")).toBeLessThan(source.indexOf("runnerMsys2Root,"));
    expect(source).toContain("mingw32");
    expect(source).toContain("mingw64");
    expect(source).toContain("webview/webview.h");
    expect(host).toContain("wWinMain");
    expect(host).toContain("window.navigate");
    expect(host).toContain("WM_SETICON");
    expect(host).toContain("window.window()");
    expect(host).toContain("--url");
    expect(source).toContain('"-static"');
    expect(source).toContain("resourceCompiler");
    expect(source).toContain("stageWebView2HeadersForX86");
  });

  it("downloads and validates the Evergreen Bootstrapper on demand at runtime", () => {
    const source = read("server.mjs");
    expect(source).toContain("https://go.microsoft.com/fwlink/?linkid=2124703");
    expect(source).toContain("MZ");
    expect(source).toContain("Get-AuthenticodeSignature");
    expect(source).toContain("SignerCertificate.Subject -notmatch 'Microsoft'");
    expect(source).toContain("Download and run the official installer (~2 MB) now?");
  });

  it("assembles one portable release asset from platform native artifacts", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");
    expect(workflow).toContain("native-musl:");
    expect(workflow).toContain("build:linux-x64-musl");
    expect(workflow).toContain("lite-native-linux-x64-musl");
    expect(workflow).toContain("Upload native addon for Lite package");
    expect(workflow).toContain("Download native addons from all release platforms");
    expect(workflow).toContain("PORTABLE_REQUIRE_WINDOWS_EXE: \"1\"");
    expect(workflow).toContain("msys2/setup-msys2@v2");
    expect(workflow).toContain("MSYS2_ROOT: ${{ steps.msys2.outputs.msys2-location }}");
    expect(workflow).not.toContain("ilammy/msvc-dev-cmd");
    expect(workflow).not.toContain("WebView2 Bootstrapper");
    expect(workflow).not.toContain("download-webview2-bootstrapper");
    expect(workflow).toContain("gh release upload \"$TAG\" portable-release/*.zip");
  });

  it("has an optional manually dispatched Lite CI workflow", () => {
    const workflow = readFileSync(LITE_CI_WORKFLOW, "utf8");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("codex-proxy-lite-${{ github.run_number }}");
    expect(workflow).toContain("Build Lite zip");
    expect(workflow).toContain("Build WebView2 hosts");
    expect(workflow).toContain("MSYS2_ROOT: ${{ steps.msys2.outputs.msys2-location }}");
    expect(workflow).not.toContain("MicrosoftEdgeWebView2Setup.exe");
    expect(workflow).not.toContain("download-webview2-bootstrapper");
    expect(workflow).toContain("test-portable.mjs");
    expect(workflow).toContain("cross-platform");
    expect(workflow).toContain("native-musl:");
    expect(workflow).toContain("build:linux-x64-musl");
    expect(workflow).toContain("musl-smoke:");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).not.toContain("gh release upload");
  });
});
