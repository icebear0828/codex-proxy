# Codex Proxy API Reference

## Authentication

All proxy endpoints (chat/messages/responses) optionally accept `Authorization: Bearer {proxy_api_key}`.
Dashboard UI uses cookie-based session (`_codex_session`).

---

## API Proxy Endpoints

### POST /v1/chat/completions
OpenAI-compatible chat completion.

```jsonc
// Request
{
  "model": "o4-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // optional: low | medium | high | xhigh
}
```

- Streaming: SSE with `choice.delta` events
- Non-streaming: `{ id, choices, usage }`
- Errors: `{ error: { message, type, code } }`

### POST /v1/messages
Anthropic Messages API compatible.

```jsonc
// Request
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled"}  // optional
}
```

- Auth: `x-api-key` or `Authorization: Bearer`
- Errors: `{ type: "error", error: { type, message } }`

### POST /v1beta/models/:model\:generateContent
### POST /v1beta/models/:model\:streamGenerateContent
Google Gemini compatible.

```jsonc
// Request
{
  "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  "systemInstruction": {"parts": [{"text": "You are helpful."}]}
}
```

- Auth: `x-goog-api-key` header, `key` query param, or Bearer token
- Errors: `{ error: { code, message, status } }`

### POST /v1/responses
Native Codex Responses API passthrough (WebSocket transport).

```jsonc
// Request
{
  "model": "o4-mini",
  "instructions": "You are helpful.",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // multi-turn
}
```

- Streaming: SSE with `response.created`, `response.output_text.delta`, `response.completed`
- Non-streaming: `{ response, usage, responseId }`

#### image_generation tool

Declare `{"type": "image_generation", ...}` in `tools[]` to let the model invoke
the server-side image generation backend (`gpt-image-2`). Requires a **ChatGPT
Plus or higher** account — free plans have the tool silently stripped upstream
and the model falls back to returning SVG text.

**Supported fields** (all optional except `type`):

| Field | Enum / range | Default | Notes |
|---|---|---|---|
| `size` | `1024x1024`, `1024x1536`, `1536x1024`, `2048x2048`, `2048x3072`, `3072x2048`, `3840x2160` (4K UHD), `2160x3840` (4K portrait), `2304x3072` (3:4), `auto` | `auto` | Width and height must both be divisible by 16. Longest edge ≤ 3840 px. Total pixel budget ≈ 8 MP (`3072x3072` rejected). Resolutions below 1024 px also rejected (min pixel budget) |
| `output_format` | `png` / `jpeg` / `webp` | `png` | `gif` is rejected |
| `output_compression` | integer 0–100 | `100` | **jpeg / webp only** — PNG rejects any non-100 |
| `background` | `auto` / `opaque` | `auto` | `transparent` is rejected for this model |
| `moderation` | `auto` / `low` | `auto` | other enums rejected |
| `partial_images` | integer 0–3 | 0 | `>3` rejected |

**Silently rewritten / hard-rejected fields**:

- `model` — whatever you send, upstream forces `gpt-image-2`.
- `quality` — any value is echoed back as `auto`; the user-supplied value has no effect.
- `n` — rejected (`unknown_parameter`); one image per call.
- `input_image`, `mask`, `input_fidelity`, `style`, `response_format` — rejected.

**Event stream order** (when the model invokes the tool):

1. `response.created` — echoes `tools[]` with upstream-normalized fields.
2. `response.output_item.added` — `{type: "image_generation_call", ...}`.
3. `response.image_generation_call.in_progress` → `.generating` → (optional) `.partial_image` × N.
4. `response.output_item.done` — the completed `image_generation_call` with:
   - `result` — base64-encoded image bytes (PNG / JPEG / WebP by `output_format`).
   - `revised_prompt` — the final prompt the model actually used.
5. `response.completed`.

**Edit mode** (supply a reference image): put an `input_image` block in the user
message content. `data:` URLs and HTTPS URLs both work.

```jsonc
{
  "model": "gpt-5.5",
  "stream": true,
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "Make this sky a sunset."},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA...", "detail": "high"}
    ]
  }],
  "tools": [{"type": "image_generation", "size": "1024x1024"}]
}
```

Legal content-part types (from upstream enum validation): `input_text`,
`input_image`, `output_text`, `refusal`, `input_file`, `computer_screenshot`,
`summary_text`.

### Ollama-Compatible Bridge

The optional bridge runs on a separate listener, defaulting to `http://127.0.0.1:11434`.
It is disabled by default and can be controlled through Dashboard settings or the admin
API. Ollama endpoints are intentionally unauthenticated; keep the listener bound to
localhost unless you explicitly trust the network.
Browser CORS access is restricted to loopback origins (`localhost`, `127.x.x.x`,
and `::1`) so non-local web pages cannot read bridge responses by default. The
bridge injects the configured Codex Proxy API key for `/v1/*` passthrough
requests, so exposing it beyond localhost also exposes the main proxy API
without requiring clients to know that key.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/version` | Version probe → `{ version }` |
| GET | `/api/tags` | Model list in Ollama format |
| POST | `/api/show` | Model metadata and capabilities |
| POST | `/api/chat` | Chat completions, streaming as NDJSON by default |
| Any | `/v1/*` | OpenAI-compatible passthrough to the main proxy |

```jsonc
// POST http://127.0.0.1:11434/api/chat
{
  "model": "codex",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "think": "medium"  // optional: false | true | low | medium | high | xhigh
}
```

Supported request mappings:

| Ollama field | Upstream OpenAI field |
|--------------|-----------------------|
| `messages[].images` | `content[].image_url` data URLs |
| `tools` | `tools` |
| `think` | `reasoning_effort` |
| `format: "json"` | `response_format: { type: "json_object" }` |
| `format: { ... }` | strict JSON schema response format |
| `options.temperature` | `temperature` |
| `options.top_p` | `top_p` |
| `options.num_predict` | `max_tokens` |

---

## Models

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List models (OpenAI format) |
| GET | `/v1/models/catalog` | Full catalog with reasoning efforts |
| GET | `/v1/models/:id` | Single model detail |
| GET | `/v1/models/:id/info` | Extended model info |
| GET | `/v1beta/models` | List models (Gemini format) |
| POST | `/admin/refresh-models` | Force refresh from upstream |

---

## Account Management

### CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts` | List all accounts |
| POST | `/auth/accounts` | Add single account (`{ token?, refreshToken? }`) |
| DELETE | `/auth/accounts/:id` | Delete account |
| PATCH | `/auth/accounts/:id/label` | Set label (`{ label }`) |

### Batch Operations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/accounts/import` | Bulk import (`{ accounts: [{token?, refreshToken?, label?}] }`) |
| POST | `/auth/accounts/batch-delete` | Bulk delete (`{ ids: [] }`) |
| POST | `/auth/accounts/batch-status` | Bulk enable/disable (`{ ids: [], status: "active"\|"disabled" }`) |

### Health & Quota

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/accounts/health-check` | Check accounts (`{ ids?, stagger_ms?, concurrency? }`) |
| POST | `/auth/accounts/:id/refresh` | Refresh single account |
| GET | `/auth/accounts/:id/quota` | Get quota/usage |
| POST | `/auth/accounts/:id/reset-usage` | Reset usage counters |

### Export

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts/export` | Export accounts (`?ids=a,b&format=minimal`) |

### Cookies (Cloudflare)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts/:id/cookies` | Get stored cookies |
| POST | `/auth/accounts/:id/cookies` | Set cookies (`{ cookies }`) |
| DELETE | `/auth/accounts/:id/cookies` | Clear cookies |

---

## OAuth & Login

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login-start` | Start OAuth → `{ authUrl, state }` |
| GET | `/auth/login` | 302 redirect to Auth0 |
| POST | `/auth/code-relay` | OAuth code exchange (`{ callbackUrl }`) |
| GET | `/auth/callback` | OAuth callback handler |
| POST | `/auth/device-login` | Start device code flow |
| GET | `/auth/device-poll/:deviceCode` | Poll device authorization |
| POST | `/auth/import-cli` | Import from Codex CLI auth.json |
| POST | `/auth/token` | Manual token submit |
| GET | `/auth/status` | Auth status + pool summary |
| POST | `/auth/logout` | Clear all accounts |

---

## Proxy Pool Management

### CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/proxies` | List proxies with health & assignments |
| POST | `/api/proxies` | Add proxy (`{ url }` or `{ host, port, username, password }`) |
| PUT | `/api/proxies/:id` | Update proxy |
| DELETE | `/api/proxies/:id` | Delete proxy |

### Health & Control

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/proxies/:id/check` | Health check single proxy |
| POST | `/api/proxies/check-all` | Health check all proxies |
| POST | `/api/proxies/:id/enable` | Enable proxy |
| POST | `/api/proxies/:id/disable` | Disable proxy |

### Assignments (Account ↔ Proxy)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/proxies/assignments` | List all assignments |
| POST | `/api/proxies/assign` | Assign proxy to account (`{ accountId, proxyId }`) |
| DELETE | `/api/proxies/assign/:accountId` | Unassign |
| POST | `/api/proxies/assign-bulk` | Bulk assign (`{ assignments: [] }`) |
| POST | `/api/proxies/assign-rule` | Auto-assign by rule (`{ rule: "round-robin", ... }`) |

### Import/Export

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/proxies/export` | Export as YAML |
| POST | `/api/proxies/import` | Import YAML or plain text (`host:port:user:pass`) |
| GET | `/api/proxies/assignments/export` | Export assignments |
| POST | `/api/proxies/assignments/import` | Preview assignment import |
| POST | `/api/proxies/assignments/apply` | Apply assignment import |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/api/proxies/settings` | Update health check interval |

---

## Admin & Settings

### General

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/general-settings` | Get all settings |
| POST | `/admin/general-settings` | Update settings (returns `restart_required`) |
| GET | `/admin/settings` | Get proxy API key |
| POST | `/admin/settings` | Set proxy API key |
| GET | `/admin/rotation-settings` | Get rotation strategy |
| POST | `/admin/rotation-settings` | Set rotation strategy |
| GET | `/admin/quota-settings` | Get quota settings |
| POST | `/admin/quota-settings` | Set quota settings |
| GET | `/admin/ollama-settings` | Get Ollama Bridge settings plus runtime status |
| POST | `/admin/ollama-settings` | Persist Ollama Bridge settings and restart the bridge |
| GET | `/admin/ollama-status` | Get Ollama Bridge runtime status |

### Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe → `{ status, authenticated, pool }` |
| POST | `/admin/test-connection` | Full connectivity diagnostics |
| GET | `/debug/fingerprint` | TLS fingerprint config (localhost only) |
| GET | `/debug/diagnostics` | System diagnostics (localhost only) |
| GET | `/debug/models` | Model store internals |

### Updates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/update-status` | Check update availability |
| POST | `/admin/check-update` | Trigger update check |
| POST | `/admin/apply-update` | Apply self-update (SSE progress stream) |

### Usage Statistics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/usage-stats/summary` | Cumulative usage by account/model |
| GET | `/admin/usage-stats/history` | Time-series data (`?granularity=hourly&hours=24`) |

### Quota Warnings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/quota/warnings` | Active quota warnings |

---

## Dashboard Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/dashboard-login` | Login with password → sets session cookie (rate limited: 5/min) |
| POST | `/auth/dashboard-logout` | Clear session |
| GET | `/auth/dashboard-status` | Check if login required |

---

## Error Formats

Each protocol returns errors in its native format:

| Protocol | Format |
|----------|--------|
| OpenAI | `{ error: { message, type, code, param } }` |
| Anthropic | `{ type: "error", error: { type, message } }` |
| Gemini | `{ error: { code, message, status } }` |
| Responses | `{ type: "error", error: { type, code, message } }` |
| Admin | `{ error: "..." }` |

Common HTTP status codes: `401` (not authenticated), `429` (rate limited), `503` (no available accounts).
