# Codex Proxy

A reverse proxy that exposes the [Codex Desktop](https://openai.com/codex) API as an OpenAI-compatible `/v1/chat/completions` endpoint. Use any OpenAI-compatible client (Cursor, Continue, VS Code, etc.) with Codex models — for free.

## Architecture

```
OpenAI-compatible client
        │
   POST /v1/chat/completions
        │
        ▼
  ┌─────────────┐     POST /backend-api/codex/responses
  │ Codex Proxy │ ──────────────────────────────────────► chatgpt.com
  │  :8080      │ ◄──────────────────────────────────────  (SSE stream)
  └─────────────┘
        │
   SSE chat.completion.chunk
        │
        ▼
    Client
```

The proxy translates OpenAI Chat Completions format to the Codex Responses API format, handles authentication (OAuth PKCE), multi-account rotation, and Cloudflare bypass via curl subprocess.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the proxy (dev mode with hot reload)
npm run dev

# 3. Open the dashboard and log in with your ChatGPT account
#    http://localhost:8080

# 4. Test a chat completion
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Features

- **OpenAI-compatible API** — drop-in replacement for `/v1/chat/completions` and `/v1/models`
- **OAuth PKCE login** — native browser-based login, no manual token copying
- **Multi-account rotation** — add multiple ChatGPT accounts with automatic load balancing (`least_used` or `round_robin`)
- **Auto token refresh** — JWT tokens are refreshed automatically before expiry
- **Cloudflare bypass** — all upstream requests use curl subprocess with native TLS
- **Quota monitoring** — real-time Codex usage/quota display per account
- **Web dashboard** — manage accounts, view usage, and monitor status at `http://localhost:8080`
- **Auto-update detection** — polls the Codex Desktop appcast for new versions

## Available Models

| Model ID | Alias | Description |
|----------|-------|-------------|
| `gpt-5.3-codex` | `codex` | Latest frontier agentic coding model (default) |
| `gpt-5.2-codex` | — | Previous generation coding model |
| `gpt-5.1-codex-max` | `codex-max` | Maximum capability coding model |
| `gpt-5.2` | — | General-purpose model |
| `gpt-5.1-codex-mini` | `codex-mini` | Lightweight, fast coding model |

## API Usage

### Chat Completions (streaming)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [
      {"role": "system", "content": "You are a helpful coding assistant."},
      {"role": "user", "content": "Write a Python function to check if a number is prime."}
    ],
    "stream": true
  }'
```

### Chat Completions (non-streaming)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### List Models

```bash
curl http://localhost:8080/v1/models
```

### Check Account Quota

```bash
curl "http://localhost:8080/auth/accounts?quota=true"
```

## Configuration

All configuration is in `config/default.yaml`:

| Section | Key Settings |
|---------|-------------|
| `api` | `base_url`, `timeout_seconds` |
| `client` | `originator`, `app_version`, `platform`, `arch` |
| `model` | `default` model, `default_reasoning_effort` |
| `auth` | `oauth_client_id`, `rotation_strategy`, `rate_limit_backoff_seconds` |
| `server` | `host`, `port`, `proxy_api_key` |

Environment variable overrides:

| Variable | Overrides |
|----------|-----------|
| `PORT` | `server.port` |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `CODEX_JWT_TOKEN` | `auth.jwt_token` |

## Client Setup Examples

### Cursor

Settings > Models > OpenAI API Base:
```
http://localhost:8080/v1
```

### Continue (VS Code)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "codex",
    "apiBase": "http://localhost:8080/v1"
  }]
}
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm run check-update` | Check for new Codex Desktop versions |
| `npm run extract -- --path <asar>` | Extract fingerprint from Codex app |
| `npm run apply-update` | Apply extracted fingerprint updates |

## License

For personal use only. This project is not affiliated with OpenAI.
