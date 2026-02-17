# Codex Proxy API Reference

Base URL: `http://localhost:8080`

---

## OpenAI-Compatible Endpoints

### POST /v1/chat/completions

OpenAI Chat Completions API. Translates to Codex Responses API internally.

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <proxy-api-key>   # optional, if proxy_api_key is configured
```

**Request Body:**
```json
{
  "model": "gpt-5.3-codex",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "temperature": 0.7
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model ID or alias (`codex`, `codex-max`, `codex-mini`) |
| `messages` | array | Yes | OpenAI-format message array |
| `stream` | boolean | No | `true` for SSE streaming (default), `false` for single JSON response |
| `temperature` | number | No | Sampling temperature |

**Response (streaming):** SSE stream of `chat.completion.chunk` objects, ending with `[DONE]`.

**Response (non-streaming):**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gpt-5.3-codex",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

---

### GET /v1/models

List all available models (OpenAI-compatible format).

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.3-codex", "object": "model", "created": 1700000000, "owned_by": "openai" },
    { "id": "codex", "object": "model", "created": 1700000000, "owned_by": "openai" }
  ]
}
```

### GET /v1/models/:modelId

Get a single model by ID or alias.

### GET /v1/models/:modelId/info

Extended model info with reasoning efforts, capabilities, and description.

**Response:**
```json
{
  "id": "gpt-5.3-codex",
  "model": "gpt-5.3-codex",
  "displayName": "gpt-5.3-codex",
  "description": "Latest frontier agentic coding model.",
  "isDefault": true,
  "supportedReasoningEfforts": [
    { "reasoningEffort": "low", "description": "Fast responses with lighter reasoning" },
    { "reasoningEffort": "medium", "description": "Balances speed and reasoning depth" },
    { "reasoningEffort": "high", "description": "Greater reasoning depth" },
    { "reasoningEffort": "xhigh", "description": "Extra high reasoning depth" }
  ],
  "defaultReasoningEffort": "medium",
  "inputModalities": ["text", "image"],
  "supportsPersonality": true,
  "upgrade": null
}
```

**Model Aliases:**

| Alias | Resolves To |
|-------|-------------|
| `codex` | `gpt-5.3-codex` |
| `codex-max` | `gpt-5.1-codex-max` |
| `codex-mini` | `gpt-5.1-codex-mini` |

---

## Authentication

### GET /auth/status

Pool-level auth status summary.

**Response:**
```json
{
  "authenticated": true,
  "user": { "email": "user@example.com", "accountId": "...", "planType": "free" },
  "proxy_api_key": "codex-proxy-...",
  "pool": { "total": 1, "active": 1, "expired": 0, "rate_limited": 0, "refreshing": 0, "disabled": 0 }
}
```

### GET /auth/login

Start OAuth login via Codex CLI. Returns `authUrl` to open in browser.

**Response:**
```json
{ "authUrl": "https://auth0.openai.com/authorize?..." }
```

### POST /auth/token

Submit a JWT token manually.

**Request Body:**
```json
{ "token": "eyJhbGci..." }
```

### POST /auth/logout

Clear all accounts and tokens.

---

## Account Management

### GET /auth/accounts

List all accounts with usage stats.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `quota` | string | Set to `"true"` to include official Codex quota for each active account |

**Response:**
```json
{
  "accounts": [
    {
      "id": "3ef8086e25b10091",
      "email": "user@example.com",
      "accountId": "0e555622-...",
      "planType": "free",
      "status": "active",
      "usage": {
        "request_count": 42,
        "input_tokens": 12000,
        "output_tokens": 8500,
        "last_used": "2026-02-17T10:00:00.000Z",
        "rate_limit_until": null
      },
      "addedAt": "2026-02-17T06:38:23.740Z",
      "expiresAt": "2026-02-27T00:46:57.000Z",
      "quota": {
        "plan_type": "free",
        "rate_limit": {
          "allowed": true,
          "limit_reached": false,
          "used_percent": 5,
          "reset_at": 1771902673
        },
        "code_review_rate_limit": null
      }
    }
  ]
}
```

> `quota` field only appears when `?quota=true` and the account is active. Uses `curl` subprocess to bypass Cloudflare TLS fingerprinting.

### POST /auth/accounts

Add a new account via JWT token.

**Request Body:**
```json
{ "token": "eyJhbGci..." }
```

**Response:**
```json
{ "success": true, "account": { ... } }
```

### DELETE /auth/accounts/:id

Remove an account by ID.

### POST /auth/accounts/:id/reset-usage

Reset local usage counters (request_count, tokens) for an account.

### GET /auth/accounts/:id/quota

Query real-time official Codex quota for a single account.

**Response (success):**
```json
{
  "quota": {
    "plan_type": "free",
    "rate_limit": {
      "allowed": true,
      "limit_reached": false,
      "used_percent": 5,
      "reset_at": 1771902673
    },
    "code_review_rate_limit": null
  },
  "raw": {
    "plan_type": "free",
    "rate_limit": {
      "allowed": true,
      "limit_reached": false,
      "primary_window": {
        "used_percent": 5,
        "limit_window_seconds": 604800,
        "reset_after_seconds": 562610,
        "reset_at": 1771902673
      },
      "secondary_window": null
    },
    "code_review_rate_limit": { ... },
    "credits": null,
    "promo": null
  }
}
```

**Response (error):**
```json
{ "error": "Failed to fetch quota from Codex API", "detail": "Codex API error (403): ..." }
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 404 | Account ID not found |
| 409 | Account is not active (expired/rate_limited/disabled) |
| 502 | Upstream Codex API error |

---

## System

### GET /health

Health check with auth and pool status.

**Response:**
```json
{
  "status": "ok",
  "authenticated": true,
  "user": { "email": "...", "accountId": "...", "planType": "free" },
  "pool": { "total": 1, "active": 1, "expired": 0, "rate_limited": 0, "refreshing": 0, "disabled": 0 },
  "timestamp": "2026-02-17T10:00:00.000Z"
}
```

### GET /debug/fingerprint

Show current client fingerprint headers, config, and prompt loading status.

### GET /

Web dashboard (HTML). Shows login page if not authenticated, dashboard if authenticated.

---

## Error Format

All errors follow the OpenAI error format for `/v1/*` endpoints:
```json
{
  "error": {
    "message": "Human-readable description",
    "type": "invalid_request_error",
    "param": null,
    "code": "error_code"
  }
}
```

Management endpoints (`/auth/*`) use a simpler format:
```json
{ "error": "Human-readable description" }
```

---

## Quick Start

```bash
# 1. Start the proxy
npx tsx src/index.ts

# 2. Add a token (or use the web UI at http://localhost:8080)
curl -X POST http://localhost:8080/auth/token \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGci..."}'

# 3. Chat (streaming)
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# 4. Check account quota
curl http://localhost:8080/auth/accounts

# 5. Check official Codex usage limits
curl "http://localhost:8080/auth/accounts?quota=true"
```
