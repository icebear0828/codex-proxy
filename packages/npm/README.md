# @icebear0828/codex-proxy

OpenAI-compatible proxy for the ChatGPT Codex Responses API, with a web dashboard, a multi-account key pool and an Ollama-compatible bridge. This is the full application — dashboard, account management and the Ollama bridge all work the same as the desktop and Docker versions.

## Install

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install -g @icebear0828/codex-proxy
```

## Run

```bash
codex-proxy            # starts the server and opens the dashboard
codex-proxy --mode=server   # headless server only
codex-proxy --mode=browser  # force the system browser
codex-proxy --help          # all options
```

On first start the dashboard opens at `http://127.0.0.1:8080` (port configurable via `--port` or `PORT`). On Windows the dashboard opens in your system browser; the desktop app and the Lite zip ship a native WebView2 host, which the npm package does not include.

Runtime data (accounts, config, usage history) is stored in the per-user data directory (`%APPDATA%\@codex-proxy\electron\data` on Windows, `~/.config/@codex-proxy/electron/data` on Linux, `~/Library/Application Support/@codex-proxy/electron/data` on macOS), so it survives package updates. Set `CODEX_PROXY_DATA_DIR` or pass `--portable` to relocate it. Platform-specific TLS addons are installed automatically for your OS/architecture (Windows x64+arm64, macOS x64+arm64, Linux x64+arm64 with glibc and musl variants); binaries for other platforms are never downloaded.

## Links

- [GitHub repository](https://github.com/icebear0828/codex-proxy)
- [Documentation & screenshots](https://github.com/icebear0828/codex-proxy#readme)
- Desktop installers, the portable zip and Docker images are published on the [releases page](https://github.com/icebear0828/codex-proxy/releases).

## License

Non-commercial licence — see [LICENCE](https://github.com/icebear0828/codex-proxy/blob/dev/LICENCE).
