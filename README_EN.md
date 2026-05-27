<div align="center">

  <h1>Codex Proxy</h1>
  <h3>Your Local Codex Coding Assistant Gateway</h3>
  <p>Expose Codex Desktop's capabilities as standard OpenAI / Anthropic / Gemini APIs, seamlessly connecting any AI client.</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-quick-start">Quick Start</a> &bull;
    <a href="#-features">Features</a> &bull;
    <a href="#-available-models">Models</a> &bull;
    <a href="#-client-setup">Client Setup</a> &bull;
    <a href="#-configuration">Configuration</a> &bull;
    <a href="#-acknowledgements">Acknowledgements</a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> |
    <strong>English</strong>
  </p>

  <br>

  <a href="https://x.com/IceBearMiner"><img src="https://img.shields.io/badge/Follow-@IceBearMiner-000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://github.com/icebear0828/codex-proxy/issues"><img src="https://img.shields.io/github/issues/icebear0828/codex-proxy?style=flat-square" alt="Issues"></a>
  <a href="#-donate"><img src="https://img.shields.io/badge/Donate-WeChat-07C160?style=flat-square&logo=wechat&logoColor=white" alt="Donate"></a>

</div>

---

> **Disclaimer**: This project is independently developed and maintained by a single person — built to scratch my own itch. I have my own account pipeline and am not short on tokens; this project exists because I needed it, not to freeload off anyone.
>
> I open-source and maintain this voluntarily. Features get added when I need them; bugs get fixed as soon as I find them. But I am under no obligation to serve any individual user's demands.
>
> Think the code is garbage? Don't use it. Think you can do better? Open a PR and join as a contributor. The issue tracker is for bug reports and suggestions — not feature demands, update nagging, or unsolicited code reviews.

---

**Codex Proxy** is a lightweight local gateway that translates the [Codex Desktop](https://openai.com/codex) Responses API into multiple standard protocol endpoints — OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, Gemini, Codex `/v1/responses` passthrough, and an optional Ollama-compatible `/api/chat` bridge. Use Codex coding models directly in Cursor, Claude Code, Continue, or any compatible client.

Just a ChatGPT account (or a third-party API key provider) and this proxy — your own personal AI coding assistant gateway, running locally.

## 🚀 Quick Start

### Desktop App (Easiest)

Download the installer from [GitHub Releases](https://github.com/icebear0828/codex-proxy/releases):

| Platform | Installer |
|----------|-----------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

Open the app, log in with your ChatGPT account. Dashboard at `http://localhost:8080`.

### Docker

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
# Open http://localhost:8080 to log in
```

> Data persists in `data/`. Cross-container access: use host LAN IP (e.g. `192.168.x.x:8080`), not `localhost`. Uncomment Watchtower in `docker-compose.yml` for auto-updates. To enable the Ollama-compatible bridge in Docker, see [Ollama Bridge configuration](#ollama-bridge-configuration).

### From Source

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install                        # Backend dependencies
cd web && npm install && cd ..     # Frontend dependencies
npm run dev                        # Dev mode (hot reload)
# Or: npm run build && npm start   # Production mode
```

> **Requires Rust toolchain** (for TLS native addon):
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> cd native && npm install && npm run build && cd ..
> ```
> Docker / desktop app ship pre-built addons — no manual compilation needed.

### Verify

After logging in, open the dashboard at `http://localhost:8080` and find your API Key in the **API Configuration** section:

```bash
# Replace your-api-key with the key shown in the dashboard
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

If you see streaming AI text, the setup is working. If you get 401, double-check the API Key.

## 🌟 Features

### 1. 🔌 Full Protocol Compatibility
- Compatible with `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic), Gemini, and `/v1/responses` (Codex passthrough)
- Optional built-in Ollama-compatible bridge, defaulting to `http://127.0.0.1:11434`
- SSE streaming, works with all OpenAI / Anthropic SDKs and clients
- Automatic bidirectional translation between all protocols and Codex Responses API
- **Structured Outputs** — `response_format` (`json_object` / `json_schema`) and Gemini `responseMimeType`
- **Function Calling** — native `function_call` / `tool_calls` across all protocols
- **Third-party API keys** — supports OpenAI / Anthropic / Gemini / OpenRouter / custom OpenAI-compatible providers, routed by model.

### 2. 🔐 Account Management & Smart Rotation
- **OAuth PKCE login** — one-click browser auth
- **Multi-account rotation** — `least_used`, `round_robin`, and `sticky` strategies
- **Plan Routing** — accounts on different plans (free/plus/team/business) auto-route to their supported models
- **Auto token refresh** — JWT renewed before expiry with exponential backoff
- **Passive quota collection** — updates account quota from upstream response headers and WebSocket rate-limit events; `quota.refresh_interval_minutes` only controls local usage snapshots, and `0` disables that timer.
- **Ban detection** — upstream 403 auto-marks banned; 401 token invalidation auto-expires and switches account
- **API key provider pool** — manage third-party API keys, model lists, import/export, and enable/disable state from the dashboard.
- **Web dashboard** — account management, usage stats, batch operations; dashboard login gate for remote access

### 3. 🌐 Proxy Pool
- **Per-account proxy routing** — different upstream proxies per account
- **Four assignment modes** — Global Default / Direct / Auto / Specific proxy
- **Health checks** — scheduled + manual, reports exit IP and latency
- **Auto-mark unreachable** — unreachable proxies excluded from rotation

### 4. 🛡️ Anti-Detection & Protocol Impersonation
- **Rust Native TLS** — built-in reqwest + rustls native addon, TLS fingerprint matches real Codex Desktop exactly (pinned dependency versions)
- **Desktop header replication** — `originator`, `User-Agent`, `x-openai-internal-codex-residency`, `x-codex-turn-state`, `x-client-request-id` headers sent per real client behavior
- **Cookie persistence** — automatic Cloudflare cookie capture and replay
- **Fingerprint auto-update** — polls Codex Desktop update feed, auto-syncs `app_version` and `build_number`

## 🏗️ Architecture

```
                                Codex Proxy
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Client (Cursor / Claude Code / Continue / SDK / ...)    │
│       │                                                  │
│  POST /v1/chat/completions (OpenAI)                      │
│  POST /v1/messages         (Anthropic)                   │
│  POST /v1/responses        (Codex passthrough)           │
│  POST /gemini/*            (Gemini)                      │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐   │
│  │  Routes   │──▶│  Translation  │──▶│    Proxy     │   │
│  │  (Hono)  │   │ Multi→Codex   │   │ Native TLS   │   │
│  └──────────┘   └───────────────┘   └──────┬───────┘   │
│       ▲                                     │           │
│       │          ┌───────────────┐          │           │
│       └──────────│  Translation  │◀─────────┘           │
│                  │ Codex→Multi   │  SSE stream          │
│                  └───────────────┘                       │
│                                                          │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │   Auth   │  │  Fingerprint  │  │   Model Store    │  │
│  │OAuth/API │  │ Rust (rustls) │  │ Static + Dynamic │  │
│  │ API Keys │  │  Headers/UA   │  │  Plan Routing    │  │
│  └──────────┘  └───────────────┘  └──────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
              Rust Native Addon (napi-rs)
            reqwest 0.12.28 + rustls 0.23.36
           (TLS fingerprint = real Codex Desktop)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
             chatgpt.com   3rd-party providers
         /backend-api/codex  (3rd-party API)
```

## 📦 Available Models

| Model ID | Reasoning | Current context | Max context | Max output | Output | Description |
|----------|-----------|-----------------|-------------|------------|--------|-------------|
| `gpt-5.5` | low / medium / high / xhigh | 272,000 | 272,000 | 128,000 | text | Frontier model for complex coding, research, and real-world work |
| `gpt-5.4` | low / medium / high / xhigh | 272,000 | 1,000,000 | 128,000 | text | Strong model for everyday coding (default) |
| `gpt-5.4-mini` | low / medium / high / xhigh | 400,000 | — | 128,000 | text | GPT-5.4 lightweight model |
| `gpt-5.3-codex` | low / medium / high / xhigh | 400,000 | — | 128,000 | text | GPT-5.3 coding-optimized model |
| `gpt-5.2` | low / medium / high / xhigh | 400,000 | — | 128,000 | text | Professional work & long-running agents |
| `gpt-5-codex` | low / medium / high | 400,000 | — | 128,000 | text | GPT-5 coding-optimized model |
| `gpt-5-codex-mini` | medium / high | — | — | — | text | Lightweight Codex / CLI coding model |
| `gpt-oss-120b` | low / medium / high | 131,072 | — | — | text | Open-source 120B model |
| `gpt-oss-20b` | low / medium / high | 131,072 | — | — | text | Open-source 20B model |
| `gpt-image-2` | — | — | — | — | image | Image-generation tool backend, invoked via `image_generation` |

> **Suffixes**: Append `-fast` to any chat model for Fast mode, `-high`/`-low` for reasoning effort. E.g. `gpt-5.4-fast`, `gpt-5.4-high-fast`. The image model (`gpt-image-2`) does not take suffixes.
>
> **Plan Routing**: Accounts on different plans auto-route to the models returned for that account by the Codex backend. Do not treat old Plus-only notes as fixed model access rules. Models are dynamically fetched and auto-synced; if a model appears in the Dashboard or `/v1/models/catalog`, it can be used as the request `model`.
>
> **Dashboard model picker ≠ config file**: Changing the model in the Dashboard only affects the UI display and API examples — it does **not** modify `model.default` in `config/default.yaml` or `data/local.yaml`. The actual model used is determined by the `model` field in each client request (Cursor, Claude Code, etc.). The `model.default` config is only a fallback when the client omits the model field.
>
> **Max token note**: the table follows the current `config/models.yaml` and Codex runtime `/v1/models/catalog` metadata. `—` means the current catalog does not return that field, not that the model is unavailable. Runtime data fetched from the Codex backend overrides static values and preserves `contextWindow`, `maxContextWindow`, `maxOutputTokens`, and `truncationPolicyLimit`. Request fields such as `context_window`, `max_context_window`, `truncation_policy`, and `max_output_tokens` are not usable switches; forwarding them to the native Codex API returns `400 Unsupported parameter`.

### 🖼️ Image Generation

Image generation rides on `/v1/responses` via the built-in `image_generation` tool; the backend is always `gpt-image-2`.

**Prerequisite**: a **ChatGPT Plus or higher** account (free accounts have the tool silently stripped by upstream, and the model falls back to replying with an SVG snippet).

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": [{"role":"user","content":"Draw a red circle on white background."}],
    "tools": [{"type":"image_generation","size":"3840x2160"}]
  }'
```

Tunable fields: `size` (1024×1024 / 1024×1536 / 1536×1024 / 2048×2048 / 2048×3072 / 3072×2048 / 3840×2160 (4K UHD) / `auto`; longest edge ≤ 3840 px, pixel budget ≈ 8 MP), `output_format` (`png` / `jpeg` / `webp`), `output_compression` (jpeg / webp only), `background` (`auto` / `opaque`), `moderation` (`auto` / `low`), `partial_images` (0–3). Upstream forces `model = gpt-image-2` and rejects `n`, `input_image`, `mask`, `input_fidelity`, `style`, `response_format`. See [API.md](./API.md#image_generation-tool) for the full matrix.

In the stream, the `image_generation_call` item's `result` field is a base64-encoded image; `revised_prompt` contains the final prompt used by the model.

**Edit mode** (with a reference image): include `{"type":"input_image","image_url":"data:image/png;base64,..."}` in the user message `content` array.

> The `/v1/chat/completions` compatibility path accepts the `image_generation` tool so OpenAI clients do not fail schema validation, but image payloads are only exposed reliably through `/v1/responses` as `image_generation_call.result`. Use `/v1/responses` when you need the image bytes.

## 🔗 Client Setup

> Get your API Key from the dashboard (`http://localhost:8080`). Use a concrete model ID (default `gpt-5.4`) or any [model ID](#-available-models) as the model name.

### Claude Code (CLI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# Switch model: export ANTHROPIC_MODEL=gpt-5.4 / gpt-5.4-fast / gpt-5.4-mini ...
claude
```

> Copy env vars from the **Anthropic SDK Setup** card in the dashboard (includes Opus / Sonnet / Haiku tier model config).
>
> Recommended models: Opus → `gpt-5.4`, Sonnet → `gpt-5.3-codex`, Haiku → `gpt-5.4-mini`.

### Codex CLI

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

# Inline the API Key (recommended for local single-user setups)
[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 To keep the key out of the config file (shared machine / open-source repo), drop the `http_headers` block and use `env_key = "PROXY_API_KEY"` instead, then `export PROXY_API_KEY=your-api-key && codex`.

### Claude Desktop

1. **Enable Developer Mode**: Click menu **Help** → **Troubleshooting** → **Enable Developer Mode**.
2. **Configure Third-Party Inference**: Click the new **Developer** menu → **Configure Third-Party Inference...**.
3. **Fill in details**:
   - **Endpoint**: `http://127.0.0.1:8080`
   - **API Key**: your-api-key
   - **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

> Alternatively, edit the config file (usually a JSON file in `%APPDATA%\Claude-3p\configLibrary\` on Windows, or `~/Library/Application Support/Claude-3p/configLibrary/` on Mac), adding the following fields:
> ```json
> {
>   "disableDeploymentModeChooser": true,
>   "inferenceProvider": "gateway",
>   "inferenceGatewayBaseUrl": "http://127.0.0.1:8080",
>   "inferenceGatewayApiKey": "your-api-key",
>   "inferenceGatewayAuthScheme": "bearer",
>   "inferenceModels": [
>     "claude-opus-4-7",
>     "claude-sonnet-4-6",
>     "claude-haiku-4-5"
>   ]
> }
> ```

Built-in Claude-shaped model names map to Codex models. Put custom mappings in `data/local.yaml`; do not edit `config/models.yaml`:

```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    claude-sonnet-4-6: gpt-5.4
    claude-haiku-4-5: gpt-5.3-codex
    my-openai: openai:gpt-4o
    my-deepseek: deepseek-chat
```

The left side is the model name used by the client; the right side is the real upstream model. The target can be a Codex model ID, a provider-prefixed model such as `openai:gpt-4o` / `anthropic:claude-sonnet-4-5` / `gemini:gemini-2.5-pro`, or a model already bound to a custom provider via `model_routing` such as `deepseek-chat`. Aliases appear in `/v1/models`; direct provider requests rewrite the outgoing `model` to the mapped target.

> 💡 **Troubleshooting (Windows)**: If Claude Desktop shows `ERR_CONNECTION_REFUSED` when using `127.0.0.1` (and `must use https` when using `localhost`), it means Node.js is only binding to IPv6 by default. Go to the Codex Proxy dashboard settings, change **Host** to `127.0.0.1`, or add `server: { host: "127.0.0.1" }` to `data/local.yaml` and restart the proxy.
>
> 💡 **LAN Usage Tip**: Claude Desktop strictly validates the endpoint and **only allows** `https://` or exactly `http://127.0.0.1`. If your proxy is on another machine in the LAN (e.g. `192.168.x.x`), you cannot use it directly via HTTP. Workarounds:
> 1. **SSH Tunnel (Easiest)**: Run `ssh -L 8080:127.0.0.1:8080 user@192.168.x.x` on your client machine, then use `http://127.0.0.1:8080` in Claude.
> 2. **Reverse Proxy**: Setup Caddy or Nginx with a valid HTTPS certificate for your LAN IP.

### Codex Desktop (Official App)

The official client shares configuration with the CLI. Restart the app after editing.

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 **Why not `env_key`?** macOS/Windows GUI apps do not inherit env vars from your shell rc files — `export PROXY_API_KEY=...` in your terminal is invisible to the GUI process and Codex Desktop will fail with `Missing environment variable`. Inlining `Authorization` via `http_headers` avoids `launchctl setenv` / LaunchAgent gymnastics. Switch back to `env_key = "PROXY_API_KEY"` only when you need the key out of the config file.
>
> ⚠️ When logged in via "ChatGPT account", existing sessions might bypass this config and hit the official upstream directly. New sessions started after `[model_providers.proxy_codex]` is wired up + `profiles.default.model_provider = "proxy_codex"` will route through the proxy.

### Claude for VSCode / JetBrains

Open Claude extension settings → **API Configuration**:
- **API Provider**: Anthropic
- **Base URL**: `http://localhost:8080`
- **API Key**: your API key

### Cursor

1. Settings → Models → OpenAI API
2. **Base URL**: `http://localhost:8080/v1`
3. **API Key**: your API key
4. Add model `gpt-5.4`

### Windsurf

1. Settings → AI Provider → **OpenAI Compatible**
2. **API Base URL**: `http://localhost:8080/v1`
3. **API Key**: your API key
4. **Model**: `gpt-5.4`

### Cline (VSCode Extension)

1. Cline sidebar → gear icon
2. **API Provider**: OpenAI Compatible
3. **Base URL**: `http://localhost:8080/v1`
4. **API Key**: your API key
5. **Model ID**: `gpt-5.4`

### Continue (VSCode Extension)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "gpt-5.4",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

### aider

```bash
aider --openai-api-base http://localhost:8080/v1 \
      --openai-api-key your-api-key \
      --model openai/gpt-5.4
```

### Cherry Studio

1. Settings → Model Services → Add
2. **Type**: OpenAI
3. **API URL**: `http://localhost:8080/v1`
4. **API Key**: your API key
5. Add model `gpt-5.4`

### Ollama-Compatible Clients

Enable it in Dashboard → Settings → **Ollama Bridge**, then use the default Ollama base URL:

| Setting | Value |
|---------|-------|
| Base URL | `http://localhost:11434` |
| API Key | Not required; the bridge uses the Codex Proxy key internally |
| Model | `gpt-5.4` (or any model ID) |

```bash
curl http://localhost:11434/api/tags

curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

> The Ollama API has no authentication. The bridge listens on `127.0.0.1` by default; do not expose it to the public internet or untrusted LANs.

### Any OpenAI-Compatible Client

| Setting | Value |
|---------|-------|
| Base URL | `http://localhost:8080/v1` |
| API Key | from dashboard |
| Model | `gpt-5.4` (or any model ID) |

<details>
<summary>SDK examples (Python / Node.js)</summary>

**Python**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-api-key")
for chunk in client.chat.completions.create(
    model="gpt-5.4", messages=[{"role": "user", "content": "Hello!"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js**
```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "your-api-key" });
const stream = await client.chat.completions.create({
  model: "gpt-5.4", messages: [{ role: "user", content: "Hello!" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

</details>

## ⚙️ Configuration

All configuration in `config/default.yaml`:

### CORS Allowed Hosts

Configure allowed CORS origins via the `CORS_ALLOWED_HOSTS` environment variable, which maps to the `server.cors` field in the config file. Separate multiple hosts with commas:

```bash
export CORS_ALLOWED_HOSTS="example.com,another-domain.com"
```

Or in `data/local.yaml`:

```yaml
server:
  cors:
    - "https://example.com"
    - "https://another-domain.com"
```

| Section | Key Settings | Description |
|---------|-------------|-------------|
| `server` | `host`, `port`, `proxy_api_key` | Listen address and API key |
| `api` | `base_url`, `timeout_seconds` | Upstream API URL and timeout |
| `client` | `app_version`, `build_number`, `chromium_version` | Codex Desktop version to impersonate |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier`, `aliases`, `custom_models`, `inject_desktop_context` | Default model, reasoning config, aliases, and custom catalog entries |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | Rotation strategy and rate limit backoff |
| `tls` | `proxy_url`, `force_http11` | TLS proxy and HTTP version |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | Usage snapshots, threshold config, exhausted-account skipping |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | Dashboard session management |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama-compatible bridge |

### Model Aliases

`model.aliases` maps client-facing model names to the real upstream model. This is useful when Claude Desktop / Cursor / Continue only lets you pick certain model IDs, or when you want shorter local names.

You can also manage aliases in Dashboard → Settings → **Model Aliases**. Saving writes to `data/local.yaml` and hot-reloads the backend, so you do not need to edit `config/default.yaml`.

```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    sonnet-local: gpt-5.4
    openai-fast: openai:gpt-4o
    deepseek-local: deepseek-chat

providers:
  custom:
    deepseek:
      api_key: "sk-..."
      base_url: "https://api.deepseek.com/v1"
      models: ["deepseek-chat"]
model_routing:
  deepseek-chat: deepseek
```

Alias resolution runs before `model_routing` and built-in Claude/Gemini auto-routing. Aliases targeting Codex models still work with Codex suffixes such as `-fast` / `-high`; aliases targeting third-party providers rewrite the outgoing direct request `model` field to the mapped target.

If you need to add fully custom Codex-compatible model IDs to the catalog, configure `model.custom_models` in `data/local.yaml`. A string entry uses default text/medium metadata; an object entry can define display name, reasoning efforts, context, and output limits:

```yaml
model:
  custom_models:
    - local-simple
    - id: local-rich
      display_name: Local Rich
      description: Local rich model
      supported_reasoning_efforts: [low, high]
      default_reasoning_effort: high
      input_modalities: [text, image]
      output_modalities: [text]
      context_window: 12345
      max_context_window: 23456
      max_output_tokens: 3456
```

### Quota Rotation

When `quota.skip_exhausted: true`, the account pool skips accounts whose cached quota is already exhausted before session affinity / `preferredEntryId` is applied. A long conversation therefore cannot force routing back to a cached-exhausted account.

The skip condition is currently `rate_limit.limit_reached === true`, `secondary_rate_limit.limit_reached === true`, or `code_review_rate_limit.limit_reached === true` in cached quota. If `used_percent` is merely near 100, for example 99%, but upstream has not set `limit_reached`, the proxy may still use that account. Once upstream returns 429, the account is marked `rate_limited`, enters backoff, and the request is retried with another available account. Secondary and code-review windows are removed from cache after their own `reset_at` passes, so an account is not skipped forever on stale quota data.

### Ollama Bridge Configuration

```yaml
ollama:
  enabled: false          # true = start the built-in Ollama-compatible listener
  host: 127.0.0.1         # localhost-only by default
  port: 11434             # Ollama default port
  version: "0.18.3"       # value returned by /api/version
  disable_vision: false   # true = do not advertise vision in /api/show
```

Supported Ollama endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `http://localhost:11434/api/version` | GET | Ollama version probe |
| `http://localhost:11434/api/tags` | GET | Model list |
| `http://localhost:11434/api/show` | POST | Model metadata |
| `http://localhost:11434/api/chat` | POST | Chat completions with streaming NDJSON |
| `http://localhost:11434/v1/*` | Any | OpenAI `/v1` passthrough |

For Docker deployments that need host access to `11434`:

1. Set `ollama.enabled: true` and `ollama.host: 0.0.0.0` in the Dashboard or `data/local.yaml`.
2. Uncomment the `127.0.0.1:${OLLAMA_BRIDGE_PORT:-11434}:11434` port mapping in `docker-compose.yml`.
3. Keep the host binding on `127.0.0.1` unless you intentionally want to expose an unauthenticated Ollama API.

Browser CORS access is limited to loopback origins such as `localhost`, `127.x.x.x`, and `::1`; non-local web origins are not allowed to read bridge responses. The bridge injects the configured Codex Proxy API key for `/v1/*` passthrough requests, so exposing it beyond localhost effectively grants unauthenticated access to the main proxy API.

### Listen Address

The source/Docker default config listens on `::` (IPv6 unspecified, usually still reachable from localhost). Electron passes `127.0.0.1` at startup unless `data/local.yaml` explicitly overrides `server.host`. To force localhost-only binding:

```yaml
server:
  host: "127.0.0.1"
```

To allow LAN access, set `server.host: "0.0.0.0"` in `data/local.yaml` and use a strong proxy API key.

### API Key

```yaml
server:
  proxy_api_key: "pwd"    # clients use Authorization: Bearer pwd
  # proxy_api_key: null   # no global key; logged-in accounts still have account-level codex-proxy-xxxx keys
```

On first startup, if `data/local.yaml` is missing, Codex Proxy creates it with `server.proxy_api_key: pwd`. The active key is shown in the dashboard API Configuration section.

### Environment Variable Overrides

| Variable | Overrides |
|----------|-----------|
| `PORT` | `server.port` |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `HTTPS_PROXY` | `tls.proxy_url` |
| `OLLAMA_BRIDGE_ENABLED` | `ollama.enabled` |
| `OLLAMA_BRIDGE_HOST` | `ollama.host` |
| `OLLAMA_BRIDGE_PORT` | `ollama.port` |
| `OLLAMA_BRIDGE_VERSION` | `ollama.version` |
| `OLLAMA_BRIDGE_DISABLE_VISION` | `ollama.disable_vision` |

## 📡 API Endpoints

<details>
<summary>Click to expand main endpoint list</summary>

**Protocol Endpoints**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI format chat completions |
| `/v1/responses` | POST | Codex Responses API passthrough |
| `/v1/responses/compact` | POST | Codex compact response proxy |
| `/v1/messages` | POST | Anthropic format chat completions |
| `/v1/models` | GET | List available models |
| `/v1/models/catalog` | GET | Full model catalog for the dashboard |
| `/v1/models/:modelId/info` | GET | Reasoning and metadata for one model |
| `/v1beta/models` | GET | Gemini-format model list |
| `/v1beta/models/:modelAction` | POST | Gemini `generateContent` / `streamGenerateContent` |
| `:11434/api/chat` | POST | Ollama-compatible chat completions (requires Ollama Bridge) |

**Auth & Accounts**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | OAuth login entry |
| `/auth/accounts` | GET | Account list (`?quota=true` / `?quota=fresh`) |
| `/auth/accounts` | POST | Add single account (token or refreshToken) |
| `/auth/accounts/import` | POST | Bulk import accounts |
| `/auth/accounts/export` | GET | Export accounts (`?format=minimal` for compact) |
| `/auth/accounts/batch-delete` | POST | Batch delete accounts |
| `/auth/accounts/batch-status` | POST | Batch update account status |
| `/auth/accounts/health-check` | POST | Batch account health check |
| `/auth/accounts/:id/refresh` | POST | Refresh and probe one account |
| `/auth/accounts/:id/quota` | GET | Actively query one account quota |
| `/auth/accounts/:id/cookies` | GET/POST/DELETE | Manage account Cloudflare cookies |
| `/auth/quota/warnings` | GET | Current quota warning state |

**Third-Party API Keys**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/api-keys/catalog` | GET | Built-in providers and suggested model catalog |
| `/auth/api-keys` | GET/POST | List / add API keys |
| `/auth/api-keys/models` | POST | Fetch models from a custom OpenAI-compatible provider |
| `/auth/api-keys/export` | GET | Export API key config |
| `/auth/api-keys/import` | POST | Import API key config |
| `/auth/api-keys/batch-delete` | POST | Batch delete API keys |
| `/auth/api-keys/:id` | DELETE | Delete one API key |
| `/auth/api-keys/:id/label` | PATCH | Update API key label |
| `/auth/api-keys/:id/status` | PATCH | Enable or disable an API key |

**Account Import/Export Examples**

```bash
# Export all accounts (full format with tokens)
curl -s http://localhost:8080/auth/accounts/export \
  -H "Authorization: Bearer your-api-key" > backup.json

# Export minimal format (refreshToken + label only, safe to share)
curl -s "http://localhost:8080/auth/accounts/export?format=minimal" \
  -H "Authorization: Bearer your-api-key" > backup-minimal.json

# Bulk import (token, refreshToken, or both)
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "accounts": [
      { "token": "eyJhbGciOi..." },
      { "refreshToken": "v1.abc..." },
      { "refreshToken": "v1.def...", "label": "Backup" }
    ]
  }'
# Returns: { "added": 2, "updated": 1, "failed": 0, "errors": [] }

# One-step backup restore (export file → import to another instance)
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d @backup.json
```

**Admin**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/rotation-settings` | GET/POST | Rotation strategy config |
| `/admin/quota-settings` | GET/POST | Quota refresh & warning config |
| `/admin/ollama-settings` | GET/POST | Ollama Bridge config |
| `/admin/ollama-status` | GET | Ollama Bridge runtime status |
| `/admin/refresh-models` | POST | Trigger manual model list refresh |
| `/admin/usage-stats/summary` | GET | Usage stats summary |
| `/admin/usage-stats/history` | GET | Usage time series |
| `/admin/logs` | GET | Request log list |
| `/admin/logs/state` | GET/POST | Log capture settings |
| `/admin/update-status` | GET | Self-update status |
| `/admin/check-update` | POST | Check for updates |
| `/admin/apply-update` | POST | Apply self-update |
| `/health` | GET | Health check |

**Proxy Pool**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/proxies` | GET/POST | List / add proxies |
| `/api/proxies/:id` | PUT/DELETE | Update / remove proxy |
| `/api/proxies/:id/check` | POST | Health check single proxy |
| `/api/proxies/check-all` | POST | Health check all proxies |
| `/api/proxies/assign` | POST | Assign proxy to account |
| `/api/proxies/assignments` | GET | View account proxy assignments |
| `/api/proxies/assign-bulk` | POST | Bulk assign proxies |
| `/api/proxies/assign-rule` | POST | Rule-based proxy assignment |
| `/api/proxies/export` | GET | Export proxy pool YAML |
| `/api/proxies/import` | POST | Import proxy pool YAML |

</details>

## 📋 Requirements

- **Node.js** 18+ (20+ recommended)
- **Rust** — required for source builds (compiles TLS native addon); Docker / desktop app ship pre-built
- **ChatGPT account** — free account is sufficient
- **Docker** (optional)

## ⚠️ Notes

- Codex API is **stream-only**. `stream: false` causes the proxy to stream internally and return assembled JSON.
- This project relies on Codex Desktop's public API. Upstream updates are auto-detected and fingerprints auto-synced.
- Windows source builds need Rust toolchain for the TLS native addon. Docker deployment has it pre-built.

## ☕ Donate & Community

<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="./.github/assets/donate.png" width="180" alt="WeChat Donate"><br>
        <sub>☕ Donate</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/wechat.png" width="180" alt="WeChat Group"><br>
        <sub>💬 WeChat</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/tgimage.png" width="180" alt="Telegram Group"><br>
        <sub>💬 Telegram</sub>
      </td>
    </tr>
  </table>
</div>

## 🙏 Acknowledgements

Codex Proxy is primarily maintained by one person, but it has been improved by a lot of community help. Special thanks to these contributors who submitted code, documentation, fixes, or PRs:

[@SsuJojo](https://github.com/SsuJojo) · [@TutuchanXD](https://github.com/TutuchanXD) · [@kanweiwei](https://github.com/kanweiwei) · [@et2010](https://github.com/et2010) · [@d-demand-priv](https://github.com/d-demand-priv) · [@hangox](https://github.com/hangox) · [@jarvisluk](https://github.com/jarvisluk) · [@jeasonstudio](https://github.com/jeasonstudio) · [@JPClaw12](https://github.com/JPClaw12) · [@lezi-fun](https://github.com/lezi-fun) · [@lookvincent](https://github.com/lookvincent) · [@pocper1](https://github.com/pocper1) · [@woai66](https://github.com/woai66) · [@xsShuang](https://github.com/xsShuang) · [@yuwei5380](https://github.com/yuwei5380) · [@aeltorio](https://github.com/aeltorio) · [@williamjameshandley](https://github.com/williamjameshandley) · [@FlavienKlr](https://github.com/FlavienKlr)

Thanks as well to everyone who opened [Issues](https://github.com/icebear0828/codex-proxy/issues) with bug reproductions, logs, compatibility reports, and feature suggestions. Those reports directly shaped account rotation, proxy compatibility, the Dashboard, Ollama Bridge, model compatibility, and error observability.

## 📄 License

**Non-Commercial** license:

- **Allowed**: Personal learning, research, self-hosted deployment
- **Prohibited**: Any commercial use including selling, reselling, paid proxy services, or commercial product integration

Not affiliated with OpenAI. Users assume all risks and must comply with OpenAI's Terms of Service.

---

<div align="center">
  <sub>Built with Hono + TypeScript | Powered by Codex Desktop API</sub>
</div>
