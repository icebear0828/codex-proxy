# Codex Proxy API Reference

**English** | [简体中文](./API_CN.md) | [繁體中文 (台灣)](./API_TW.md) | [繁體中文 (香港)](./API_HK.md) | [日本語](./API_JA.md)

---

## Authentication

All proxy endpoints (chat / messages / gemini / responses / embeddings / images) accept the configured proxy API key:
- Header: `Authorization: Bearer {proxy_api_key}`, `x-api-key: {proxy_api_key}`, or `x-goog-api-key: {proxy_api_key}`
- Query parameter: `?key={proxy_api_key}`

### Client Access Keys (Sub-keys)
Clients can also authenticate with a granular Client Access Key created through the Admin API or Dashboard. Client keys support spending budgets (USD), token limits, concurrency caps, allowed model restrictions, and expiration times.
- Client key self-service info endpoint: `GET /v1/sub-key/info` (requires `Authorization: Bearer {client_key}`).

### Dashboard & Admin Auth
- Dashboard UI uses cookie-based sessions (`_codex_session`).
- Admin endpoints (`/admin/*`) require either a valid dashboard session or the Master Proxy API Key via `Authorization: Bearer {master_api_key}`.

---

## API Proxy Endpoints

### POST /v1/chat/completions
OpenAI-compatible chat completion.

```jsonc
// Request
{
  "model": "gpt-5.6-sol",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // optional: low | medium | high | xhigh
}
```

- Streaming: SSE with `choice.delta` events
- Non-streaming: `{ id, choices, usage }`
- Errors: `{ error: { message, type, code } }`
- `max_tokens`, `max_completion_tokens`, and `max_output_tokens` are accepted for client compatibility but are not forwarded to native Codex backends.

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
Native Codex Responses API passthrough (HTTP POST + SSE).

```jsonc
// Request
{
  "model": "gpt-5.6-sol",
  "instructions": "You are helpful.",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // multi-turn conversation resume
}
```

- Streaming: SSE with `response.created`, `response.output_text.delta`, `response.completed`
- Non-streaming: `{ response, usage, responseId }`
- Do not send `max_output_tokens` to native Codex. The proxy accepts it only for compatibility and strips it, because the real Codex backend rejects it with `400 Unsupported parameter: max_output_tokens`.

### WebSocket /v1/responses
Native Codex Responses API WebSocket transport (issue #681).

Clients can connect via WebSocket to `ws://{host}:{port}/v1/responses` (or `wss://`) using standard authentication (e.g. `Authorization: Bearer {key}` header or `?key={key}` query param).

- The socket remains open across multiple turns.
- The client sends a `response.create` JSON payload frame.
- The proxy executes the request and streams back the `data:` JSON payloads as individual WebSocket text frames.

### POST /v1/images/generations
OpenAI Images API compatible endpoint for image generation.

```jsonc
// Request
{
  "model": "gpt-image-2",
  "prompt": "A scenic sunset over snow-capped mountains",
  "size": "1024x1024",
  "output_format": "png"
}
```

- The proxy transforms image generation requests into Codex Responses `image_generation` tool calls routed to the configured `model.image_host_model` (default: `gpt-5.5`).
- Returns OpenAI-compatible `{ created, data: [{ b64_json, revised_prompt }] }`.

### POST /v1/embeddings
OpenAI-compatible embeddings endpoint.

```jsonc
// Request
{
  "model": "text-embedding-3-small",
  "input": "Your text string goes here"
}
```

- Routed to third-party API keys configured with the `embeddings` capability.
- Returns `{ object: "list", data: [{ object: "embedding", embedding: [...], index: 0 }], model, usage }`.

---

### Codex Auxiliary Endpoints

`POST /v1/alpha/search` supports regular Codex models backed by the ChatGPT OAuth account pool and forwards them to `/backend-api/codex/alpha/search`. For OAuth Search, ordinary 4xx responses other than 401/429 are returned without changing account health or clearing cookies; positively identified Cloudflare challenges still use the safe cooldown-and-retry path. When the requested model instead resolves to an API-key provider with `wire=codex-responses`, the proxy supports all of these non-streaming JSON endpoints:

| Endpoint | Upstream target | Purpose |
|---|---|---|
| `POST /v1/alpha/search` | `<baseUrl>/alpha/search` | Codex CLI standalone Web Search |
| `POST /v1/responses/compact` | `<baseUrl>/responses/compact` | Remote conversation compaction |
| `POST /v1/images/generations` | `<baseUrl>/images/generations` | Codex JSON image generation |
| `POST /v1/images/edits` | `<baseUrl>/images/edits` | Codex JSON image editing |

Each endpoint requires a non-empty `model` in its JSON body and uses the existing model router. OAuth search reuses the account pool's cookies, proxy selection, retry/rotation, and Codex request context. API-key routes replace local authentication with the configured provider key. Apart from configured model-alias resolution, stripping an internal provider prefix, and the Responses Lite normalization described below, the proxy leaves JSON bodies unchanged and preserves the upstream status, Content-Type, and response body. Paths outside the exact allowlist are not forwarded. Local aliases without `/v1` are accepted as well. See the public [OpenAI Responses compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact/) and the [Codex CLI 0.147.0 search endpoint source](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/codex-api/src/endpoint/search.rs#L31-L45).

For Responses generation and compact requests, when `x-openai-internal-codex-responses-lite: true` is present, or the equivalent WebSocket marker appears in `client_metadata`, the proxy applies the complete Responses Lite contract: `reasoning.context` is forced to `all_turns` and `parallel_tool_calls` to `false`. This can increase retained context/token usage and serializes tool calls, but prevents the Lite marker and request body from becoming inconsistent.

#### image_generation tool

Declare `{"type": "image_generation", ...}` in `tools[]` to let the model invoke the server-side image generation backend (`gpt-image-2`). Requires a **ChatGPT Plus or higher** account — free plans have the tool silently stripped upstream and the model falls back to returning SVG text.

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

- `model` — whatever you send, upstream forces `gpt-image-2` (echoed as `gpt-image-2-codex` in responses).
- `size` — user-requested dimensions like `2048x2048`, `2K`, `4K` are echoed/normalized upstream to `auto` and the actual resolution is decided server-side (e.g. `1254x1254`).
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

**Token accounting**: `response.completed.response.usage` reports the host model's tokens; the image_generation tool's own tokens come back separately as `response.completed.response.tool_usage.image_gen.{input_tokens, output_tokens, total_tokens}`. The proxy passes both through verbatim, and tracks them as separate counters on the dashboard (`total_image_input_tokens` / `total_image_output_tokens`) so image-gen usage doesn't pollute host-model token charts.

**Request accounting**: the proxy also counts each `image_generation` request as success or failure. `total_image_request_count` increments when the upstream returned a real image (non-zero `tool_usage.image_gen.output_tokens`); `total_image_request_failed_count` increments when the tool was silently stripped (Free plan), the upstream returned an error, or the response came back empty. Both surfaces in `/admin/usage-stats/summary` and the Dashboard's "Image Requests" card.

**Edit mode** (supply a reference image): put an `input_image` block in the user message content. `data:` URLs and HTTPS URLs both work.

```jsonc
{
  "model": "gpt-5.6-sol",
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

Legal content-part types (from upstream enum validation): `input_text`, `input_image`, `output_text`, `refusal`, `input_file`, `computer_screenshot`, `summary_text`.

OpenAI Chat compatibility accepts `tools: [{"type":"image_generation"}]`, but the stable image payload is exposed by `/v1/responses` as `image_generation_call.result`. Use `/v1/responses` or `POST /v1/images/generations` for clients that need the base64 image bytes.

---

### Ollama-Compatible Bridge

The optional bridge runs on a separate listener, defaulting to `http://127.0.0.1:11434`. It is disabled by default and can be controlled through Dashboard settings or the admin API. Ollama endpoints are intentionally unauthenticated; keep the listener bound to localhost unless you explicitly trust the network.

Browser CORS access is restricted to loopback origins (`localhost`, `127.x.x.x`, and `::1`) so non-local web pages cannot read bridge responses by default. The bridge injects the configured Codex Proxy API key for `/v1/*` passthrough requests, so exposing it beyond localhost also exposes the main proxy API without requiring clients to know that key.

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
| GET | `/v1/models` | List models (OpenAI format, filtered by client key if applicable) |
| GET | `/v1/models/catalog` | Full catalog with reasoning efforts and metadata |
| GET | `/v1/models/:id` | Single model detail |
| GET | `/v1/models/:id/info` | Extended model info |
| GET | `/v1beta/models` | List models (Gemini format) |
| POST | `/admin/refresh-models` | Force refresh models from upstream |

Model catalog entries can include token metadata:

| Field | Meaning |
|-------|---------|
| `contextWindow` | Static or backend-provided context window for display and client hints |
| `maxContextWindow` | Backend-provided maximum expandable context window, when reported |
| `maxOutputTokens` | Static or backend-provided maximum output tokens for display and client hints |
| `truncationPolicyLimit` | Backend-provided truncation policy limit, when reported |
| `outputModalities` | Supported output modalities (e.g. `["text"]`, `["text", "image"]`) |

Static catalog values are defined in `config/models.yaml`; dynamic entries from `/backend-api/codex/models` take precedence when returned by upstream.

---

## Client Keys (Sub-keys) Management

Client keys allow generating sub-keys with specific budgets, model access lists, token limits, concurrency caps, and expiration dates.

### Self-Service Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/sub-key/info` | Query client key quota, remaining budget, allowed models, and usage |

### Admin Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/client-keys` | List all client keys (masked) with summary stats |
| POST | `/admin/client-keys` | Create a new client key (`{ name, key?, expires_at?, max_budget_usd?, max_tokens?, max_concurrency?, allowed_models?, default_tools? }`) |
| PUT | `/admin/client-keys/:id` | Update client key properties |
| POST | `/admin/client-keys/:id/toggle` | Toggle key between `active` and `disabled` |
| POST | `/admin/client-keys/:id/reset-usage` | Reset cost and token counters for a client key |
| DELETE | `/admin/client-keys/:id` | Delete a client key |

---

## Account Management

### CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts` | List all accounts, persistence health, and fallback upstream status |
| POST | `/auth/accounts` | Add single account (`{ token?, refreshToken? }`) |
| DELETE | `/auth/accounts/:id` | Delete account |
| PATCH | `/auth/accounts/:id/label` | Set label (`{ label }`) |
| PATCH | `/auth/accounts/:id/codex-fingerprint` | Set account TLS fingerprint mode (`{ mode: "off" \| "session" }`) |

### Batch Operations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/accounts/import` | Bulk import accounts (`{ accounts: [{token?, refreshToken?, label?}] }` or raw text) |
| POST | `/auth/accounts/batch-delete` | Bulk delete accounts (`{ ids: [] }`) |
| POST | `/auth/accounts/batch-status` | Bulk enable/disable (`{ ids: [], status: "active" \| "disabled" }`) |

### Health & Quota

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/accounts/health-check` | Check accounts connectivity (`{ ids?, stagger_ms?, concurrency? }`) |
| POST | `/auth/accounts/:id/refresh` | Refresh single account access token & status |
| GET | `/auth/accounts/:id/quota` | Get quota & usage metrics |
| POST | `/auth/accounts/:id/reset-usage` | Reset usage counters |
| GET | `/auth/accounts/:id/reset-credits` | Get reset credits info |
| POST | `/auth/accounts/:id/reset-credits/consume` | Consume reset credit (`{ redeem_request_id? }`) |

### Export

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts/export` | Export accounts (`?ids=a,b&format=minimal\|full\|csv\|token-key\|auth-json\|sub2api`) |

### Cookies (Cloudflare)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/accounts/:id/cookies` | Get stored cookies |
| POST | `/auth/accounts/:id/cookies` | Set cookies (`{ cookies }`) |
| DELETE | `/auth/accounts/:id/cookies` | Clear cookies |

### Fallback Upstream API-Key

The fallback upstream provides a last-resort API key destination when all OAuth accounts are expired, rate-limited, or unavailable.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/fallback-upstream` | Get fallback upstream configuration and status |
| POST | `/auth/fallback-upstream` | Configure fallback upstream (`{ baseUrl, apiKey }`) |
| PUT | `/auth/fallback-upstream` | Update fallback upstream (`{ baseUrl, apiKey? }`) |
| DELETE | `/auth/fallback-upstream` | Clear fallback upstream configuration |

---

## Third-Party Provider API Keys

Manage API keys for upstream providers (Anthropic, OpenAI, Gemini, OpenRouter, Custom).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/api-keys` | List configured provider API keys |
| GET | `/auth/api-keys/catalog` | Get predefined model catalog for providers |
| POST | `/auth/api-keys/models` | Fetch available models from upstream provider |
| GET | `/auth/api-keys/export` | Export provider API keys for re-import |
| POST | `/auth/api-keys/import` | Bulk import provider API keys (`{ keys: [] }`) |
| POST | `/auth/api-keys` | Add single key binding (`{ provider, models, apiKey, baseUrl?, label?, capabilities?, wire? }`) |
| POST | `/auth/api-keys/batch-delete` | Bulk delete provider API keys (`{ ids: [] }`) |
| DELETE | `/auth/api-keys/:id` | Delete provider API key |
| PATCH | `/auth/api-keys/:id/label` | Set label (`{ label }`) |
| PATCH | `/auth/api-keys/:id/status` | Set status (`{ status: "active" \| "disabled" }`) |

---

## OAuth & Login

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login-start` | Start OAuth → `{ authUrl, state }` |
| GET | `/auth/login` | 302 redirect to Auth0 |
| POST | `/auth/code-relay` | OAuth code exchange (`{ callbackUrl }`) |
| GET | `/auth/callback` | OAuth callback handler |
| POST | `/auth/device-login` | Start device code flow |
| GET | `/auth/device-poll/:deviceCode` | Poll device authorization status |
| POST | `/auth/import-cli` | Import from Codex CLI `auth.json` |
| POST | `/auth/token` | Manual token submission |
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
| DELETE | `/api/proxies/assign/:accountId` | Unassign proxy from account |
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

### General Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/general-settings` | Get all server/tls/model/logs settings |
| POST | `/admin/general-settings` | Update settings (returns `restart_required`) |
| GET | `/admin/settings` | Get Master proxy API key |
| POST | `/admin/settings` | Set Master proxy API key |
| GET | `/admin/rotation-settings` | Get rotation strategy |
| POST | `/admin/rotation-settings` | Set rotation strategy (`least_used` \| `round_robin` \| `sticky`) |
| GET | `/admin/quota-settings` | Get quota skip & refresh settings |
| POST | `/admin/quota-settings` | Set quota skip & refresh settings |
| GET | `/admin/ollama-settings` | Get Ollama Bridge settings plus runtime status |
| POST | `/admin/ollama-settings` | Persist Ollama Bridge settings and restart bridge |
| GET | `/admin/ollama-status` | Get Ollama Bridge runtime status |

### Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe → `{ status, authenticated, pool, uptime_seconds }` |
| POST | `/admin/test-connection` | Full connectivity diagnostics (server, accounts, transport, upstream) |
| GET | `/debug/fingerprint` | TLS fingerprint config (localhost only) |
| GET | `/debug/diagnostics` | System diagnostics & paths (localhost only) |
| GET | `/debug/models` | Model store internals |

### Request Logs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/logs` | List captured request logs (`?limit=&offset=&direction=&search=`) |
| GET | `/admin/logs/state` | Get logging store state (`enabled`, `paused`, `capacity`) |
| POST | `/admin/logs/state` | Update logging state (`{ enabled?, paused? }`) |
| POST | `/admin/logs/clear` | Clear all in-memory request logs |
| GET | `/admin/logs/:id` | Get single log entry details |

### Error Logs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/error-logs` | Get grouped error logs |
| GET | `/admin/error-logs/raw` | Get raw error log entries (`?limit=`) |
| GET | `/admin/error-logs/count` | Get total and unread error counts |
| POST | `/admin/error-logs/seen` | Mark error logs as read cursor |
| DELETE | `/admin/error-logs` | Clear error logs |
| POST | `/admin/error-logs/report` | Report client error (`{ source, error: { name, message, stack }, context? }`) |

### Official Codex App Server Bridge

Optional bridge to a local official `codex app-server` instance. Used for official Codex app plugins such as the Chrome/browser plugin. Disabled by default (`official_agent.enabled: false`). Requires dedicated `official_agent.api_key`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/official-agent/apps` | List official Codex apps/connectors from `app/list` |
| POST | `/official-agent/threads` | Start an app-server thread (`{ model?, cwd? }`) |
| POST | `/official-agent/threads/:threadId/turns` | Start a turn and stream app-server notifications as SSE |

### Updates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/update-status` | Check update availability |
| POST | `/admin/check-update` | Trigger update check |
| POST | `/admin/apply-update` | Apply self-update (SSE progress stream) |

### Usage Statistics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/usage-stats/summary` | Cumulative usage by account/model/client key |
| GET | `/admin/usage-stats/history` | Time-series data (`?granularity=raw\|five_min\|hourly\|daily&hours=24\|all`) |

### Quota Warnings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/quota/warnings` | Active quota warnings |

When `quota.skip_exhausted` is enabled, account acquisition filters out active accounts whose cached quota has `rate_limit.limit_reached === true`, `secondary_rate_limit.limit_reached === true`, or `code_review_rate_limit.limit_reached === true`. This happens before session affinity, so `preferredEntryId` cannot keep a request on an exhausted account. Near-full quota such as `used_percent=99` is not skipped until upstream marks `limit_reached` or the account receives a 429 and enters `rate_limited` backoff.

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
