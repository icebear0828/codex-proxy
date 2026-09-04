# No-Node Lite Browser/Server distribution

This distribution keeps the existing Electron package unchanged. It contains
the bundled backend and web assets, but does not contain Node.js. It uses the
same per-user data directory as Electron by default; pass `--portable` when
you explicitly want runtime data beside the package.

After extracting the `tar.xz` archive, the top-level entry points are:

- `codex-proxy.exe` on Windows when the native launcher was built;
- `codex-proxy.cmd` on Windows, always included as a script fallback;
- `codex-proxy.sh` on macOS/Linux.

The launcher uses the system Node.js by default. Node.js 20 or newer is
required for this release. A custom path can be supplied before the
application arguments:

```text
codex-proxy.exe -n C:\Tools\node.exe -m browser
./codex-proxy.sh -n /opt/node/bin/node -m server
```

If no mode is supplied to the Windows native launcher, it checks for the
packaged WebView2 host and an installed WebView2 Runtime. When both are
available it starts the embedded WebView2 window; otherwise it starts the
server and opens the actual server URL in the default browser. The native
Windows launcher also stays in the notification area and provides Open
Dashboard and Quit actions. The URL is generated from the bound port, so a
configured port or an automatic port fallback is respected. The `.cmd`
launcher keeps the same Windows `auto` behavior for diagnostics. The POSIX
launcher uses browser mode by default, including when it is invoked from Git
Bash on Windows; pass `--mode=auto` explicitly when WebView2 selection is
desired. Supported modes are:

```text
  --mode, -m <mode>          server, browser, auto, or webview2
  --portable, -p             Store runtime data in the package's data directory
  --host, -H <host>           Override the listen host
  --port, -P <port>           Override the listen port
  --webview2-host, -w <path>  Use a specific WebView2 host executable
  --help, -h                  Show this help
```

Without `--portable`, the launcher uses the Electron-compatible per-user data
directory (`%APPDATA%/@codex-proxy/electron/data` on Windows,
`~/.config/@codex-proxy/electron/data` on Linux, and
`~/Library/Application Support/@codex-proxy/electron/data` on macOS). This
allows the No-Node Lite package to reuse the existing Electron configuration.
With `--portable`, all runtime data is kept in the package's `data/` directory.
The two modes must not be run concurrently against the same data directory.

The WebView2 host is a separate Windows native component. A development build
without that host fails clearly in `webview2` mode; it does not silently fall
back to a browser. The repository provides a small host source that can be
built with MSYS2 MinGW-w64 (x86 and x64):

```text
node scripts/portable/build-webview2-host.mjs --arch x64
node scripts/portable/build-webview2-host.mjs --arch x86
```

The builder looks for `MSYS2_ROOT`, `D:\DevTools\Tools\msys64`, and then
`C:\msys64`. The MSYS2 UCRT64 environment must provide `g++` and the
`mingw-w64-ucrt-x86_64-webview` package. A release package can provide the
compiled hosts with `--webview2-host-x86 PATH` and `--webview2-host-x64 PATH`.
The resulting package includes the MIT notice for the `webview` library.

The WebView2 Runtime is not bundled. If the target machine does not have it,
the default `auto` mode falls back to the browser. Explicit
`--mode=webview2` reports the missing Runtime and asks whether to run the
optional Evergreen Bootstrapper. The question times out without installing
anything if there is no response. The Bootstrapper can install it online:

```text
npm run download:webview2-bootstrapper -- --out PATH
node scripts/portable/build-portable.mjs \
  --webview2-host-x86 PATH\\win-x86\\webview2-host.exe \
  --webview2-host-x64 PATH\\win-x64\\webview2-host.exe \
  --webview2-bootstrapper PATH\\MicrosoftEdgeWebView2Setup.exe
```

The package places the installer at
`tools/MicrosoftEdgeWebView2Setup.exe` and writes its SHA-256 beside it. The
installer is a small online downloader; it requires internet access and does
not replace the WebView2 host or install Node.js. Run it explicitly with
`/silent /install` after user confirmation. Evergreen WebView2 supports
Windows 10 SAC 1709 and later, supported Windows 10 LTSC/IoT editions,
Windows 11, and the supported Windows Server editions. Windows 7 and 8.1 are
outside the current Evergreen support target.

The supported Windows Server targets are Windows Server 2016 LTSC, 2019 LTSC,
2022 LTSC, and supported Server SAC releases.

For local branch testing, set `CODEX_PROXY_FORCE_NO_WEBVIEW2=1` before starting
the launcher. This forces the runtime-detection branch without uninstalling or
modifying the machine's WebView2 Runtime. In `auto` mode it should fall back to
the browser; in explicit `--mode=webview2` mode it should show the installation
guidance and timeout behavior.

The Windows launcher shows a timed Node.js installation/help dialog when it
cannot start Node.js. The `.cmd` and POSIX launchers print the same guidance
and offer to open the official Node.js download page, also with a 15-second
timeout. They never silently download or install Node.js.

The launcher changes the child process working directory to the package root
before starting `app/server.mjs`. Resource paths for `config/`, `public/`,
`bin/`, and `native/` remain package-local in both modes; only mutable runtime
data switches between the Electron-compatible user directory and package-local
`data/`.

The package is intentionally bring-your-own-Node. It does not silently
download or execute Node.js or the WebView2 Runtime. The optional Bootstrapper
is downloaded from Microsoft's official endpoint during packaging, checked as
a Windows executable, and verified by the Windows CI job's Authenticode check.

The Windows native launcher is a small x86 PE built with the MSYS2 MinGW-w64
`mingw32` toolchain and the Windows GUI subsystem. It statically links the
MinGW runtime and only imports normal Windows system DLLs, so the package does
not need to ship MinGW DLLs. It owns a small notification-area icon while the
Node server is running and captures the dynamically bound dashboard URL and
WebView2 host path. In WebView2 mode the native launcher owns the WebView2
window, so closing that window leaves the server and tray icon running; Open
Dashboard can create or focus the WebView2 window again. In browser/server mode
it opens the default browser instead. The tray also has a Check for Updates
item that opens the latest No-Node Lite release page for manual replacement. The
build keeps `codex-proxy.cmd` beside it in every package; if MSYS2 is not
available or the native build fails, the package still remains usable through
the script launcher.

## Distribution tests

The archive-level test reads the generated tar.xz, checks its layout and Unix
modes, and runs the package from an unrelated working directory. It also
checks the current host's native addon, the no-Node guidance, the server HTTP
smoke path, browser URL forwarding, and the non-Windows WebView2 error:

    npm run test:lite -- --archive portable-release/codex-proxy-2.0.77-no-node-lite-all-platforms.tar.xz

On an isolated Windows runner, add `--test-native-launcher` to also start the
native `codex-proxy.exe`. The native launcher uses a single-instance mutex, so
this option should not be run while another Lite/Electron launcher is active
for the same user session.

CI runs the same test on Windows, macOS, and Linux. The native build matrix
also checks the platform/architecture-specific .node files. Unsupported
architectures are covered by the loader contract test; they require a
matching native build or emulator before they can be promoted to runtime
smoke tests.
