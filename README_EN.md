<div align="center">

  <h1>Codex Proxy</h1>
  <h3>Your Local Codex Coding Assistant Gateway</h3>
  <p>Expose Codex Desktop's capabilities as a standard OpenAI API, seamlessly connecting any AI client.</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
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

```bash
# 1. Clone the repo
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy

# 2. Install dependencies
npm install

# 3. Start the proxy (dev mode with hot reload)
npm run dev

# 4. Open the dashboard and log in with your ChatGPT account
#    http://localhost:8080

# 5. Test a request
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## 🌟 Features

### 1. 🔌 Full Protocol Compatibility
- Complete `/v1/chat/completions` and `/v1/models` endpoint support
- SSE streaming output, works with all OpenAI SDKs and clients
- Automatic bidirectional translation between Chat Completions and Codex Responses API

### 2. 🔐 Account Management & Smart Rotation
- **OAuth PKCE login** — one-click browser auth, no manual token copying
- **Multi-account rotation** — `least_used` and `round_robin` scheduling strategies
- **Auto token refresh** — JWT renewed automatically before expiry
- **Real-time quota monitoring** — dashboard shows remaining usage per account

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

| Model ID | Alias | Description |
|----------|-------|-------------|
| `gpt-5.2-codex` | `codex` | Latest agentic coding model (default) |
| `gpt-5.1-codex-mini` | `codex-mini` | Lightweight, fast coding model |

> Models are automatically synced when new Codex Desktop versions are released.

## 🔗 Client Setup

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
| `model` | `default`, `default_reasoning_effort` | Default model and reasoning effort |
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
