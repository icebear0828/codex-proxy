# Codex Proxy API 文档

[English](./API.md) | **简体中文** | [繁體中文 (台灣)](./API_TW.md) | [繁體中文 (香港)](./API_HK.md) | [日本語](./API_JA.md)

---

## 鉴权方式

所有代理端点（chat / messages / gemini / responses / embeddings / images）支持配置好的代理 API Key：
- 请求头：`Authorization: Bearer {proxy_api_key}`、`x-api-key: {proxy_api_key}` 或 `x-goog-api-key: {proxy_api_key}`
- 查询参数：`?key={proxy_api_key}`

### 客户端子密钥（Client Keys / Sub-keys）
客户端也可以使用在后台管理面板或 Admin API 创建的细粒度 Client Key 进行认证。子密钥支持限额（USD 预算）、Token 上限、并发上限、允许访问的模型列表以及过期时间。
- 子密钥自查询端点：`GET /v1/sub-key/info`（需要传入 `Authorization: Bearer {client_key}`）。

### Dashboard 与管理接口鉴权
- Dashboard 管理面板使用 cookie session（`_codex_session`）。
- 管理接口（`/admin/*`）要求有效的 Dashboard session，或通过 `Authorization: Bearer {master_api_key}` 传入主 Proxy API Key。

---

## API 代理端点

### POST /v1/chat/completions
OpenAI 兼容的聊天补全接口。

```jsonc
// 请求体
{
  "model": "gpt-5.6-sol",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // 可选: low | medium | high | xhigh
}
```

- 流式：SSE，事件包含 `choice.delta`
- 非流式：`{ id, choices, usage }`
- 错误格式：`{ error: { message, type, code } }`
- `max_tokens`、`max_completion_tokens`、`max_output_tokens` 仅做客户端兼容解析，不会转发给 Codex 原生后端。

### POST /v1/messages
Anthropic Messages API 兼容接口。

```jsonc
// 请求体
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled"}  // 可选
}
```

- 鉴权：`x-api-key` 或 `Authorization: Bearer`
- 错误格式：`{ type: "error", error: { type, message } }`

### POST /v1beta/models/:model\:generateContent
### POST /v1beta/models/:model\:streamGenerateContent
Google Gemini 兼容接口。

```jsonc
// 请求体
{
  "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  "systemInstruction": {"parts": [{"text": "你是一个助手。"}]}
}
```

- 鉴权：`x-goog-api-key` 请求头、`key` 查询参数、或 Bearer token
- 错误格式：`{ error: { code, message, status } }`

### POST /v1/responses
原生 Codex Responses API 透传（HTTP POST + SSE）。

```jsonc
// 请求体
{
  "model": "gpt-5.6-sol",
  "instructions": "你是一个助手。",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // 多轮对话上下文延续
}
```

- 流式：SSE 事件 `response.created`、`response.output_text.delta`、`response.completed`
- 非流式：`{ response, usage, responseId }`
- 不要向原生 Codex 发送 `max_output_tokens`。代理只兼容解析并剥离该字段，因为真实 Codex 后端会返回 `400 Unsupported parameter: max_output_tokens`。

### WebSocket /v1/responses
原生 Codex Responses API WebSocket 传输（Issue #681）。

客户端可以通过 WebSocket 连接到 `ws://{host}:{port}/v1/responses`（或 `wss://`），并携带标准认证信息（如 `Authorization: Bearer {key}` 头或 `?key={key}` 查询参数）。

- 连接保持长连，支持多轮交互。
- 客户端发送 `response.create` 格式的 JSON 文本帧。
- 代理执行请求并将 SSE 的 `data:` JSON 数据逐帧返回给客户端。

### POST /v1/images/generations
OpenAI Images API 兼容的图片生成接口。

```jsonc
// 请求体
{
  "model": "gpt-image-2",
  "prompt": "A scenic sunset over snow-capped mountains",
  "size": "1024x1024",
  "output_format": "png"
}
```

- 代理将图像生成请求转换为 Codex Responses 的 `image_generation` 工具调用，并路由至配置的 `model.image_host_model`（默认：`gpt-5.5`）。
- 返回 OpenAI 兼容格式 `{ created, data: [{ b64_json, revised_prompt }] }`。

### POST /v1/embeddings
OpenAI 兼容的文本向量嵌入接口。

```jsonc
// 请求体
{
  "model": "text-embedding-3-small",
  "input": "Your text string goes here"
}
```

- 路由至配置了 `embeddings` 能力的第三方 Provider API Key。
- 返回 `{ object: "list", data: [{ object: "embedding", embedding: [...], index: 0 }], model, usage }`。

---

### Codex Responses API-Key 辅助端点

当请求模型路由到 `wire=codex-responses` 的 API-key provider 时，代理还支持以下非流式 JSON 端点：

| 端点 | 上游目标 | 用途 |
|---|---|---|
| `POST /v1/alpha/search` | `<baseUrl>/alpha/search` | Codex CLI standalone Web Search |
| `POST /v1/responses/compact` | `<baseUrl>/responses/compact` | 远程对话压缩 |
| `POST /v1/images/generations` | `<baseUrl>/images/generations` | Codex JSON 图片生成 |
| `POST /v1/images/edits` | `<baseUrl>/images/edits` | Codex JSON 图片编辑 |

所有端点都要求 body 含非空 `model`，并使用现有模型路由选择 API-key entry。代理以供应商 API key 替换本地代理鉴权；除应用已配置的模型别名/内部 provider 前缀解析外，不改写 JSON body，并原样返回上游状态码、Content-Type 与响应体。未列入白名单的路径不会转发。也接受不带 `/v1` 的本地别名。远程压缩的公开合同见 [OpenAI Responses compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact/)；standalone search 路径来自 [Codex CLI 0.147.0 官方源码](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/codex-api/src/endpoint/search.rs#L31-L45)。

#### image_generation 工具

在 `tools[]` 里声明 `{"type": "image_generation", ...}`，模型可以调用服务端图像生成后端（`gpt-image-2`）。前提：**ChatGPT Plus 及以上** 账号——free 账号上游会静默剥掉工具，模型会改用 SVG 文本假装画图。

**支持字段**（除 `type` 全部可选）：

| 字段 | 枚举 / 范围 | 默认 | 备注 |
|---|---|---|---|
| `size` | `1024x1024`、`1024x1536`、`1536x1024`、`2048x2048`、`2048x3072`、`3072x2048`、`3840x2160`（4K UHD）、`2160x3840`（4K 竖）、`2304x3072`（3:4）、`auto` | `auto` | 宽高必须都是 16 的倍数；最长边 ≤ 3840 px；总像素预算约 8 MP（`3072x3072` 会被拒）；1024 以下分辨率也被拒（最小像素预算）|
| `output_format` | `png` / `jpeg` / `webp` | `png` | `gif` 被拒 |
| `output_compression` | 整数 0–100 | `100` | **仅 jpeg / webp 生效** — png 下非 100 报错 |
| `background` | `auto` / `opaque` | `auto` | `transparent` 被拒 |
| `moderation` | `auto` / `low` | `auto` | 其他枚举被拒 |
| `partial_images` | 整数 0–3 | 0 | `>3` 被拒 |

**静默改写 / 明确拒绝的字段**：

- `model` — 不管传啥，上游强制改回 `gpt-image-2`（响应回显为 `gpt-image-2-codex`）。
- `size` — 客户端请求的 `2048x2048`、`2K`、`4K` 等尺寸会被上游回显/归一化为 `auto`，实际输出分辨率由服务端自行决定（例如实测 `1254x1254`）。
- `quality` — 传任何值都被 echo 为 `auto`，用户值不生效。
- `n` — `unknown_parameter`；一次只能出一张图。
- `input_image`、`mask`、`input_fidelity`、`style`、`response_format` — 全部拒绝。

**事件顺序**（模型调用工具时）：

1. `response.created` — `tools[]` 被上游补全默认字段回显。
2. `response.output_item.added` — `{type: "image_generation_call", ...}`。
3. `response.image_generation_call.in_progress` → `.generating` → （可选）`.partial_image` × N。
4. `response.output_item.done` — 完整的 `image_generation_call`：
   - `result` — base64 图像（格式跟 `output_format`）。
   - `revised_prompt` — 模型实际使用的最终提示词。
5. `response.completed`。

**Token 计费**：`response.completed.response.usage` 是主模型的 token；图像工具的 token 单独走 `response.completed.response.tool_usage.image_gen.{input_tokens, output_tokens, total_tokens}`。代理两边都原样透传，并且在仪表盘里把图像 token 单列为 `total_image_input_tokens` / `total_image_output_tokens`，不会和主模型的 token 混到一起。

**请求计数**：代理同时分别统计图像生成的成功 / 失败次数。`total_image_request_count` 在上游返回真实图像（`tool_usage.image_gen.output_tokens > 0`）时 +1；`total_image_request_failed_count` 在工具被静默剥除（Free 账号）、上游错误、空响应等任何失败路径下 +1。两者都通过 `/admin/usage-stats/summary` 暴露，Dashboard 的「Image Requests」卡片直接展示 `N ok · M failed`。

**编辑模式**（带参考图）：在 user message 的 content 数组里加 `input_image` 块，`data:` URL 和 HTTPS URL 都支持。

```jsonc
{
  "model": "gpt-5.6-sol",
  "stream": true,
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "把这张图的天空改成黄昏。"},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA...", "detail": "high"}
    ]
  }],
  "tools": [{"type": "image_generation", "size": "1024x1024"}]
}
```

合法 content-part 类型（由上游枚举校验回显）：`input_text`、`input_image`、`output_text`、`refusal`、`input_file`、`computer_screenshot`、`summary_text`。

OpenAI Chat 兼容路径会接受 `tools: [{"type":"image_generation"}]`，但稳定的图像 payload 只会通过 `/v1/responses` 的 `image_generation_call.result` 暴露。需要拿到 base64 图片字节时，请使用 `/v1/responses` 或 `POST /v1/images/generations`。

---

### Ollama 兼容桥接

可选桥接服务运行在独立的监听端口上，默认为 `http://127.0.0.1:11434`。默认处于关闭状态，可通过控制面板或 Admin API 开启。Ollama 端点设计为免认证，除非你信任当前网络，否则建议仅绑定在本地回环地址（localhost）。

浏览器 CORS 访问被限制在本地回环源（`localhost`、`127.x.x.x`、`::1`），非本地网页默认无法读取桥接响应。桥接层在转发 `/v1/*` 请求时会自动注入配置好的 Codex Proxy API Key，因此向局域网或公网暴露该端口等同于免密暴露代理主接口。

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/version` | 版本探测 → `{ version }` |
| GET | `/api/tags` | Ollama 格式的模型列表 |
| POST | `/api/show` | 模型元数据与能力描述 |
| POST | `/api/chat` | 聊天补全接口（默认 NDJSON 流式） |
| Any | `/v1/*` | OpenAI 兼容直通主代理 |

```jsonc
// POST http://127.0.0.1:11434/api/chat
{
  "model": "codex",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "think": "medium"  // 可选: false | true | low | medium | high | xhigh
}
```

支持的请求字段映射：

| Ollama 字段 | 上游 OpenAI 对应字段 |
|--------------|-----------------------|
| `messages[].images` | `content[].image_url` data URLs |
| `tools` | `tools` |
| `think` | `reasoning_effort` |
| `format: "json"` | `response_format: { type: "json_object" }` |
| `format: { ... }` | 严格 JSON schema 格式 |
| `options.temperature` | `temperature` |
| `options.top_p` | `top_p` |
| `options.num_predict` | `max_tokens` |

---

## 模型

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出所有模型（OpenAI 格式，带 Client Key 时会自动按权限过滤） |
| GET | `/v1/models/catalog` | 完整模型目录（含 reasoning effort 及元数据） |
| GET | `/v1/models/:id` | 单个模型详情 |
| GET | `/v1/models/:id/info` | 扩展模型信息 |
| GET | `/v1beta/models` | 列出模型（Gemini 格式） |
| POST | `/admin/refresh-models` | 强制从上游刷新模型列表 |

模型目录条目可以包含 token 元数据：

| 字段 | 含义 |
|------|------|
| `contextWindow` | 静态或上游提供的上下文窗口，用于展示和客户端参考 |
| `maxContextWindow` | 上游提供的最大可扩展上下文窗口（如果返回） |
| `maxOutputTokens` | 静态或上游提供的最大输出 token，用于展示和客户端参考 |
| `truncationPolicyLimit` | 上游提供的截断策略限制（如果返回） |
| `outputModalities` | 支持的输出模态（例如 `["text"]`、`["text", "image"]`） |

静态值定义在 `config/models.yaml`；同一模型 ID 如果从 `/backend-api/codex/models` 拉到动态条目，则以上游动态值为准。

---

## 客户端子密钥管理（Client Keys）

通过子密钥可以生成带有特定额度、模型权限、Token 限制、并发控制和过期时间的独立 API Key。

### 自服务查询端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/sub-key/info` | 查询当前 Client Key 的配额、剩余额度、允许模型和用量数据 |

### 管理员接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/client-keys` | 列出所有 Client Keys（脱敏）及汇总统计 |
| POST | `/admin/client-keys` | 创建新 Client Key（`{ name, key?, expires_at?, max_budget_usd?, max_tokens?, max_concurrency?, allowed_models?, default_tools? }`） |
| PUT | `/admin/client-keys/:id` | 更新 Client Key 配置 |
| POST | `/admin/client-keys/:id/toggle` | 快速启停 Key（`active` / `disabled`） |
| POST | `/admin/client-keys/:id/reset-usage` | 重置指定 Key 的用量花费和 Token 计数 |
| DELETE | `/admin/client-keys/:id` | 删除 Client Key |

---

## 账号管理

### 增删改查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts` | 列出所有账号、持久化健康状态与兜底上游状态 |
| POST | `/auth/accounts` | 添加单个账号（`{ token?, refreshToken? }`） |
| DELETE | `/auth/accounts/:id` | 删除账号 |
| PATCH | `/auth/accounts/:id/label` | 设置标签（`{ label }`） |
| PATCH | `/auth/accounts/:id/codex-fingerprint` | 设置账号 TLS 指纹模式（`{ mode: "off" \| "session" }`） |

### 批量操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/import` | 批量导入（`{ accounts: [{token?, refreshToken?, label?}] }` 或纯文本） |
| POST | `/auth/accounts/batch-delete` | 批量删除（`{ ids: [] }`） |
| POST | `/auth/accounts/batch-status` | 批量启停（`{ ids: [], status: "active" \| "disabled" }`） |

### 健康检查 & 配额

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/health-check` | 检查账号连通性（`{ ids?, stagger_ms?, concurrency? }`） |
| POST | `/auth/accounts/:id/refresh` | 刷新单个账号 token 和状态 |
| GET | `/auth/accounts/:id/quota` | 查看配额和用量 |
| POST | `/auth/accounts/:id/reset-usage` | 重置用量计数 |
| GET | `/auth/accounts/:id/reset-credits` | 查看 Reset Credits 信息 |
| POST | `/auth/accounts/:id/reset-credits/consume` | 消耗 Reset Credit（`{ redeem_request_id? }`） |

### 导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/export` | 导出账号（`?ids=a,b&format=minimal\|full\|csv\|token-key\|auth-json\|sub2api`） |

### Cookies（Cloudflare）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/:id/cookies` | 获取已存 cookies |
| POST | `/auth/accounts/:id/cookies` | 设置 cookies（`{ cookies }`） |
| DELETE | `/auth/accounts/:id/cookies` | 清除 cookies |

### 兜底上游 API-Key（Fallback Upstream）

当所有 OAuth 账号均不可用（过期、被限流或账号池为空）时，代理会自动路由至配置的兜底上游 API Key。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/fallback-upstream` | 获取兜底上游配置与状态 |
| POST | `/auth/fallback-upstream` | 设置兜底上游（`{ baseUrl, apiKey }`） |
| PUT | `/auth/fallback-upstream` | 更新兜底上游（`{ baseUrl, apiKey? }`） |
| DELETE | `/auth/fallback-upstream` | 清除兜底上游配置 |

---

## 第三方 Provider API Key 管理

管理第三方供应商的 API Key（Anthropic、OpenAI、Gemini、OpenRouter、Custom 等）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/api-keys` | 列出所有配置的 Provider API Keys |
| GET | `/auth/api-keys/catalog` | 获取预定义模型目录 |
| POST | `/auth/api-keys/models` | 从上游供应商拉取可用模型列表 |
| GET | `/auth/api-keys/export` | 导出 API Keys 用于重新导入 |
| POST | `/auth/api-keys/import` | 批量导入 Provider API Keys（`{ keys: [] }`） |
| POST | `/auth/api-keys` | 添加单个 Provider Key 绑定（`{ provider, models, apiKey, baseUrl?, label?, capabilities?, wire? }`） |
| POST | `/auth/api-keys/batch-delete` | 批量删除 API Keys（`{ ids: [] }`） |
| DELETE | `/auth/api-keys/:id` | 删除单个 API Key |
| PATCH | `/auth/api-keys/:id/label` | 修改 Key 标签（`{ label }`） |
| PATCH | `/auth/api-keys/:id/status` | 修改 Key 状态（`{ status: "active" \| "disabled" }`） |

---

## OAuth & 登录

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login-start` | 发起 OAuth → 返回 `{ authUrl, state }` |
| GET | `/auth/login` | 302 重定向到 Auth0 |
| POST | `/auth/code-relay` | OAuth 授权码交换（`{ callbackUrl }`） |
| GET | `/auth/callback` | OAuth 回调处理 |
| POST | `/auth/device-login` | 发起设备码流程 |
| GET | `/auth/device-poll/:deviceCode` | 轮询设备授权状态 |
| POST | `/auth/import-cli` | 从 Codex CLI auth.json 导入 |
| POST | `/auth/token` | 手动提交 token |
| GET | `/auth/status` | 认证状态 + 账号池概要 |
| POST | `/auth/logout` | 清空所有账号 |

---

## 代理池管理

### 增删改查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies` | 列出所有代理（含健康状态和分配） |
| POST | `/api/proxies` | 添加代理（`{ url }` 或 `{ host, port, username, password }`） |
| PUT | `/api/proxies/:id` | 更新代理 |
| DELETE | `/api/proxies/:id` | 删除代理 |

### 健康检查 & 控制

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/proxies/:id/check` | 检查单个代理 |
| POST | `/api/proxies/check-all` | 检查所有代理 |
| POST | `/api/proxies/:id/enable` | 启用代理 |
| POST | `/api/proxies/:id/disable` | 禁用代理 |

### 分配（账号 ↔ 代理）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies/assignments` | 列出所有分配关系 |
| POST | `/api/proxies/assign` | 分配代理给账号（`{ accountId, proxyId }`） |
| DELETE | `/api/proxies/assign/:accountId` | 取消分配 |
| POST | `/api/proxies/assign-bulk` | 批量分配（`{ assignments: [] }`） |
| POST | `/api/proxies/assign-rule` | 按规则自动分配（`{ rule: "round-robin", ... }`） |

### 导入/导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/proxies/export` | 导出为 YAML |
| POST | `/api/proxies/import` | 导入 YAML 或纯文本（`host:port:user:pass` 格式） |
| GET | `/api/proxies/assignments/export` | 导出分配关系 |
| POST | `/api/proxies/assignments/import` | 预览分配导入（不执行） |
| POST | `/api/proxies/assignments/apply` | 应用分配导入 |

### 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/api/proxies/settings` | 更新健康检查间隔 |

---

## 管理 & 设置

### 通用设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/general-settings` | 获取全部 server / tls / model / logs 设置 |
| POST | `/admin/general-settings` | 更新设置（返回 `restart_required` 标志） |
| GET | `/admin/settings` | 获取 Master proxy API key |
| POST | `/admin/settings` | 设置 Master proxy API key |
| GET | `/admin/rotation-settings` | 获取轮转策略 |
| POST | `/admin/rotation-settings` | 设置轮转策略（`least_used` \| `round_robin` \| `sticky`） |
| GET | `/admin/quota-settings` | 获取配额与跳过设置 |
| POST | `/admin/quota-settings` | 更新配额与跳过设置 |
| GET | `/admin/ollama-settings` | 获取 Ollama Bridge 设置及运行状态 |
| POST | `/admin/ollama-settings` | 持久化 Ollama Bridge 设置并重启桥接 |
| GET | `/admin/ollama-status` | 获取 Ollama Bridge 运行状态 |

### 诊断

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康探针 → `{ status, authenticated, pool, uptime_seconds }` |
| POST | `/admin/test-connection` | 完整连通性诊断（服务器、账号、传输层、上游） |
| GET | `/debug/fingerprint` | TLS 指纹配置（仅 localhost） |
| GET | `/debug/diagnostics` | 系统诊断信息与文件路径（仅 localhost） |
| GET | `/debug/models` | 模型存储内部状态 |

### 请求日志

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/logs` | 查询抓取的请求日志列表（`?limit=&offset=&direction=&search=`） |
| GET | `/admin/logs/state` | 获取请求日志存储状态（`enabled`, `paused`, `capacity`） |
| POST | `/admin/logs/state` | 更新日志抓取状态（`{ enabled?, paused? }`） |
| POST | `/admin/logs/clear` | 清空所有内存请求日志 |
| GET | `/admin/logs/:id` | 获取单条日志详细内容 |

### 错误日志

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/error-logs` | 获取聚合后的错误日志列表 |
| GET | `/admin/error-logs/raw` | 获取原始错误日志列表（`?limit=`） |
| GET | `/admin/error-logs/count` | 获取总错误数与未读错误数 |
| POST | `/admin/error-logs/seen` | 标记错误日志已读游标 |
| DELETE | `/admin/error-logs` | 清空错误日志 |
| POST | `/admin/error-logs/report` | 上报客户端错误（`{ source, error: { name, message, stack }, context? }`） |

### 官方 Codex App Server Bridge

可选桥接到本机官方 `codex app-server`。用于复用官方 Codex app 插件能力（如 Chrome/browser 插件）。默认关闭（`official_agent.enabled: false`）。强制要求独立的 `official_agent.api_key`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/official-agent/apps` | 通过 `app/list` 列出官方 Codex apps/connectors |
| POST | `/official-agent/threads` | 创建 app-server thread（`{ model?, cwd? }`） |
| POST | `/official-agent/threads/:threadId/turns` | 发起 turn，并以 SSE 流式返回 app-server notifications |

### 更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/update-status` | 检查可用更新 |
| POST | `/admin/check-update` | 触发更新检查 |
| POST | `/admin/apply-update` | 执行自更新（SSE 进度流） |

### 用量统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/usage-stats/summary` | 按账号/模型/Client Key 维度的累计用量 |
| GET | `/admin/usage-stats/history` | 时序数据（`?granularity=raw\|five_min\|hourly\|daily&hours=24\|all`） |

### 配额告警

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/quota/warnings` | 当前活跃的配额告警 |

启用 `quota.skip_exhausted` 后，账号池会在获取账号时过滤缓存额度中 `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true` 或 `code_review_rate_limit.limit_reached === true` 的 active 账号。过滤发生在 session affinity 之前，所以 `preferredEntryId` 不能把请求继续粘到已耗尽账号。如果只是 `used_percent=99` 这类临近满额，但上游还没标记 `limit_reached`，代理不会主动跳过；等上游返回 429 后，该账号会进入 `rate_limited` 退避并切换账号。

---

## Dashboard 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/dashboard-login` | 密码登录 → 设置 session cookie（限流：5次/分钟） |
| POST | `/auth/dashboard-logout` | 退出登录 |
| GET | `/auth/dashboard-status` | 检查是否需要登录 |

---

## 错误格式

各协议返回各自原生的错误结构：

| 协议 | 格式 |
|------|------|
| OpenAI | `{ error: { message, type, code, param } }` |
| Anthropic | `{ type: "error", error: { type, message } }` |
| Gemini | `{ error: { code, message, status } }` |
| Responses | `{ type: "error", error: { type, code, message } }` |
| Admin | `{ error: "..." }` |

常见 HTTP 状态码：`401`（未认证）、`429`（限流）、`503`（无可用账号）。

