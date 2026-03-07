<div align="center">

  <h1>Codex Proxy</h1>
  <h3>Your Local Codex Coding Assistant Gateway</h3>
  <p>Expose Codex Desktop's capabilities as a standard OpenAI API, seamlessly connecting any AI client.</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-features">Features</a> •
    <a href="#-architecture">Architecture</a> •
    <a href="#-client-setup">Client Setup</a> •
    <a href="#-configuration">Configuration</a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> |
    <strong>English</strong>
  </p>

</div>

---

**Codex Proxy** is a lightweight local gateway that translates the [Codex Desktop](https://openai.com/codex) Responses API into a standard OpenAI-compatible `/v1/chat/completions` endpoint. Use Codex coding models directly in Cursor, Continue, VS Code, or any OpenAI-compatible client.

Just a ChatGPT account and this proxy — your own personal AI coding assistant gateway, running locally.

## 🚀 Quick Start

### Desktop App (Easiest)

Download the installer from [GitHub Releases](https://github.com/icebear0828/codex-proxy/releases) — no setup required:

| Platform | Installer |
|----------|-----------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

Open the app and log in with your ChatGPT account. The desktop app listens on `127.0.0.1:8080` (local access only).

### CLI / Server Deployment

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
```

#### Docker (Recommended)

```bash
docker compose up -d
# Open http://localhost:8080 to log in
```

#### macOS / Linux

```bash
npm install                # Install backend deps + auto-download curl-impersonate
cd web && npm install && cd ..   # Install frontend deps
npm run dev                # Dev mode (hot reload)
# Or: npm run build && npm start  # Production mode
```

#### Windows

```bash
npm install                # Install backend deps
cd web && npm install && cd ..   # Install frontend deps
npm run dev                # Dev mode (hot reload)
```

> On Windows, curl-impersonate is not available. The proxy falls back to system curl. For full TLS impersonation, use Docker or WSL.

### Verify

```bash
# Open http://localhost:8080, log in with your ChatGPT account, then:
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

> **Cross-container access**: If other Docker containers need to connect to codex-proxy, use the host's LAN IP (e.g., `http://192.168.x.x:8080/v1`) instead of `host.docker.internal`.

## 🌟 Features

### 1. 🔌 Full Protocol Compatibility
- Compatible with `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic), and Gemini formats
- SSE streaming output, works with all OpenAI SDKs and clients
- Automatic bidirectional translation between Chat Completions and Codex Responses API

### 2. 🔐 Account Management & Smart Rotation
- **OAuth PKCE login** — one-click browser auth, no manual token copying
- **Multi-account rotation** — `least_used` and `round_robin` scheduling strategies
- **Auto token refresh** — JWT renewed automatically before expiry
- **Real-time quota monitoring** — dashboard shows remaining usage per account

### 3. 🌐 Proxy Pool
- **Per-account proxy routing** — assign different upstream proxies to different accounts for IP diversity and risk isolation
- **Four assignment modes** — Global Default, Direct (no proxy), Auto (round-robin rotation), or a specific proxy
- **Health checks** — scheduled (default every 5 min) + manual, reports exit IP and latency via ipify API
- **Auto-mark unreachable** — unreachable proxies are automatically flagged and excluded from auto-rotation
- **Dashboard management** — add/remove/check/enable/disable proxies, per-account proxy selector

### 3. 🛡️ Anti-Detection & Protocol Impersonation
- **Chrome TLS fingerprint** — curl-impersonate replicates the full Chrome 136 TLS handshake
- **Desktop header replication** — `originator`, `User-Agent`, `sec-ch-*` headers in exact Codex Desktop order
- **Desktop context injection** — every request includes the Codex Desktop system prompt for full feature parity
- **Cookie persistence** — automatic Cloudflare cookie capture and replay
- **Timing jitter** — randomized delays on scheduled operations to eliminate mechanical patterns

### 4. 🔄 Session & Version Management
- **Multi-turn conversations** — automatic `previous_response_id` for context continuity
- **Appcast version tracking** — polls Codex Desktop update feed, auto-syncs `app_version` and `build_number`
- **Web dashboard** — account management, usage monitoring, and status overview in one place

## 🏗️ Architecture

```
                            Codex Proxy
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Client (Cursor / Continue / SDK)                   │
│       │                                             │
│  POST /v1/chat/completions                          │
│       │                                             │
│       ▼                                             │
│  ┌──────────┐    ┌───────────────┐    ┌──────────┐  │
│  │  Routes   │──▶│  Translation  │──▶│  Proxy   │  │
│  │  (Hono)  │   │ OpenAI→Codex  │   │ curl TLS │  │
│  └──────────┘   └───────────────┘   └────┬─────┘  │
│       ▲                                   │        │
│       │          ┌───────────────┐        │        │
│       └──────────│  Translation  │◀───────┘        │
│                  │ Codex→OpenAI  │  SSE stream     │
│                  └───────────────┘                  │
│                                                     │
│  ┌──────────┐  ┌───────────────┐  ┌─────────────┐  │
│  │   Auth   │  │  Fingerprint  │  │   Session   │  │
│  │ OAuth/JWT│  │  Headers/UA   │  │   Manager   │  │
│  └──────────┘  └───────────────┘  └─────────────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘
                         │
                    curl subprocess
                    (Chrome TLS)
                         │
                         ▼
                    chatgpt.com
              /backend-api/codex/responses
```

## 📦 Available Models

| Model ID | Alias | Reasoning Efforts | Description |
|----------|-------|-------------------|-------------|
| `gpt-5.4` | `codex` | minimal / low / medium / high | Latest flagship coding model (default) |
| `gpt-5.3-codex` | — | low / medium / high | Previous-gen flagship agentic coding model |
| `gpt-5.3-codex-spark` | — | minimal / low | Ultra-lightweight coding model |
| `gpt-5.2-codex` | — | low / medium / high | Agentic coding model |
| `gpt-5.1-codex-max` | `codex-max` | low / medium / high | Deep reasoning coding model |
| `gpt-5.1-codex-mini` | `codex-mini` | low / medium / high | Lightweight, fast coding model |

> **Model name suffixes**: Append `-fast` to any model name to enable Fast mode, or `-high`/`-low` etc. to change reasoning effort.
> Examples: `gpt-5.4-fast`, `gpt-5.4-high-fast`, `codex-fast`.
>
> Models are automatically synced when new Codex Desktop versions are released. The backend also dynamically fetches the latest model catalog.

## 🔗 Client Setup

### Claude Code

Set environment variables to route Claude Code through codex-proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# Default Opus 4.6 → gpt-5.4, no need to set ANTHROPIC_MODEL
# To switch models or use suffixes:
# export ANTHROPIC_MODEL=codex-fast              # → gpt-5.4 + Fast mode
# export ANTHROPIC_MODEL=gpt-5.4-high            # → gpt-5.4 + high reasoning
# export ANTHROPIC_MODEL=gpt-5.4-high-fast       # → gpt-5.4 + high + Fast
# export ANTHROPIC_MODEL=claude-sonnet-4-6       # Sonnet → gpt-5.3-codex
# export ANTHROPIC_MODEL=claude-haiku-4-5-20251001  # Haiku → gpt-5.1-codex-mini

claude   # Launch Claude Code
```

| Claude Code Model | Maps to Codex Model | Notes |
|-------------------|---------------------|-------|
| Opus (default) | `gpt-5.4` | No need to set `ANTHROPIC_MODEL` |
| Sonnet (`claude-sonnet-4-6`) | `gpt-5.3-codex` | |
| Haiku (`claude-haiku-4-5-20251001`) | `gpt-5.1-codex-mini` | |

> You can also copy environment variables from the **Anthropic SDK Setup** card in the dashboard (`http://localhost:8080`).

### Cursor

Settings → Models → OpenAI API Base:
```
http://localhost:8080/v1
```

API Key (from the dashboard):
```
codex-proxy-xxxxx
```

### Continue (VS Code)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "codex",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "codex-proxy-xxxxx"
  }]
}
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="codex-proxy-xxxxx"
)

response = client.chat.completions.create(
    model="codex",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### OpenAI Node.js SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "codex-proxy-xxxxx",
});

const stream = await client.chat.completions.create({
  model: "codex",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## ⚙️ Configuration

All configuration is in `config/default.yaml`:

| Section | Key Settings | Description |
|---------|-------------|-------------|
| `server` | `host`, `port`, `proxy_api_key` | Listen address and API key |
| `api` | `base_url`, `timeout_seconds` | Upstream API URL and timeout |
| `client_identity` | `app_version`, `build_number` | Codex Desktop version to impersonate |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier` | Default model, reasoning effort and speed mode |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | Rotation strategy and rate limit backoff |

### Environment Variable Overrides

| Variable | Overrides |
|----------|-----------|
| `PORT` | `server.port` |
| `CODEX_PLATFORM` | `client_identity.platform` |
| `CODEX_ARCH` | `client_identity.arch` |

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (main endpoint) |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |
| `/auth/accounts` | GET | Account list and quota |
| `/auth/login` | GET | OAuth login entry |
| `/debug/fingerprint` | GET | Debug: view current impersonation headers |
| `/api/proxies` | GET | Proxy pool list (with assignments) |
| `/api/proxies` | POST | Add proxy (HTTP/HTTPS/SOCKS5) |
| `/api/proxies/:id` | PUT | Update proxy config |
| `/api/proxies/:id` | DELETE | Remove proxy |
| `/api/proxies/:id/check` | POST | Health check single proxy |
| `/api/proxies/:id/enable` | POST | Enable proxy |
| `/api/proxies/:id/disable` | POST | Disable proxy |
| `/api/proxies/check-all` | POST | Health check all proxies |
| `/api/proxies/assign` | POST | Assign proxy to account |
| `/api/proxies/assign/:accountId` | DELETE | Unassign proxy from account |
| `/api/proxies/settings` | PUT | Update proxy pool settings |

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production server |

## 📋 Requirements

- **Node.js** 18+
- **curl** — system curl works out of the box; install [curl-impersonate](https://github.com/lexiforest/curl-impersonate) for full Chrome TLS fingerprinting
- **ChatGPT account** — standard account is sufficient

## ⚠️ Notes

- The Codex API is **stream-only**. When `stream: false` is set, the proxy streams internally and returns the assembled response as a single JSON object.
- This project relies on Codex Desktop's public API. Upstream version updates may cause breaking changes.
- Deploy on **Linux / macOS** for full TLS impersonation. On Windows, curl-impersonate is not available and the proxy falls back to system curl.

## 📄 License

This project is licensed under **Non-Commercial** terms:

- **Allowed**: Personal learning, research, self-hosted deployment
- **Prohibited**: Any commercial use, including but not limited to selling, reselling, paid proxy services, or integration into commercial products

This project is not affiliated with OpenAI. Users assume all risks and must comply with OpenAI's Terms of Service.

---

<div align="center">
  <sub>Built with Hono + TypeScript | Powered by Codex Desktop API</sub>
</div>
