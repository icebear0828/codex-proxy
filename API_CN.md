# Codex Proxy API 文档

## 鉴权方式

所有代理端点（chat/messages/responses）可选传 `Authorization: Bearer {proxy_api_key}`。
Dashboard 管理面板使用 cookie session（`_codex_session`）。

---

## API 代理端点

### POST /v1/chat/completions
OpenAI 兼容的聊天补全接口。

```jsonc
// 请求体
{
  "model": "o4-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // 可选: low | medium | high | xhigh
}
```

- 流式：SSE，事件包含 `choice.delta`
- 非流式：`{ id, choices, usage }`
- 错误格式：`{ error: { message, type, code } }`
- `max_tokens`、`max_completion_tokens`、`max_output_tokens` 仅做客户端兼容解析，不会转发给 Codex。

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
原生 Codex Responses API 透传（底层走 WebSocket）。

```jsonc
// 请求体
{
  "model": "o4-mini",
  "instructions": "你是一个助手。",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // 多轮对话
}
```

- 流式：SSE 事件 `response.created`、`response.output_text.delta`、`response.completed`
- 非流式：`{ response, usage, responseId }`
- 不要向原生 Codex 发送 `max_output_tokens`。代理只兼容解析并剥离该字段，因为真实 Codex 后端会返回 `400 Unsupported parameter: max_output_tokens`。

#### image_generation 工具

在 `tools[]` 里声明 `{"type": "image_generation", ...}`，模型可以调用服务端图像
生成后端（`gpt-image-2`）。前提：**ChatGPT Plus 及以上** 账号——free 账号上游
会静默剥掉工具，模型会改用 SVG 文本假装画图。

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

- `model` — 不管传啥，上游强制改回 `gpt-image-2`。
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

**Token 计费**：`response.completed.response.usage` 是主模型的 token；图像工具
的 token 单独走 `response.completed.response.tool_usage.image_gen.{input_tokens,
output_tokens, total_tokens}`。代理两边都原样透传，并且在仪表盘里把图像 token
单列为 `total_image_input_tokens` / `total_image_output_tokens`，不会和主模型的
token 混到一起。

**请求计数**：代理同时分别统计图像生成的成功 / 失败次数。`total_image_request_count`
在上游返回真实图像（`tool_usage.image_gen.output_tokens > 0`）时 +1；
`total_image_request_failed_count` 在工具被静默剥（Free 账号）、上游错误、空响应等
任何失败路径下 +1。两者都通过 `/admin/usage-stats/summary` 暴露，Dashboard 的
「Image Requests」卡片直接展示 `N ok · M failed`。

**编辑模式**（带参考图）：在 user message 的 content 数组里加 `input_image`
块，`data:` URL 和 HTTPS URL 都支持。

```jsonc
{
  "model": "gpt-5.5",
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

合法 content-part 类型（由上游枚举校验回显）：`input_text`、`input_image`、
`output_text`、`refusal`、`input_file`、`computer_screenshot`、`summary_text`。

OpenAI Chat 兼容路径会接受 `tools: [{"type":"image_generation"}]`，但稳定的
图像 payload 只会通过 `/v1/responses` 的 `image_generation_call.result` 暴露。
需要拿到 base64 图片字节时，请使用 `/v1/responses`。

---

## 模型

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出所有模型（OpenAI 格式） |
| GET | `/v1/models/catalog` | 完整模型目录（含 reasoning effort） |
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

静态值定义在 `config/models.yaml`；同一模型 ID 如果从
`/backend-api/codex/models` 拉到动态条目，则以上游动态值为准。实测
2026-05-08 的 Codex 后端对 `gpt-5.5` 回传 `context_window=272000`、
`max_context_window=272000`、`truncation_policy.limit=10000`，对 `gpt-5.4`
回传 `context_window=272000`、`max_context_window=1000000`、
`truncation_policy.limit=10000`。这些是 Codex 运行时限制，不代表请求级
context 或 max-token 开关可用。

---

## 账号管理

### 增删改查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts` | 列出所有账号 |
| POST | `/auth/accounts` | 添加单个账号（`{ token?, refreshToken? }`） |
| DELETE | `/auth/accounts/:id` | 删除账号 |
| PATCH | `/auth/accounts/:id/label` | 设置标签（`{ label }`） |

### 批量操作

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/import` | 批量导入（`{ accounts: [{token?, refreshToken?, label?}] }`） |
| POST | `/auth/accounts/batch-delete` | 批量删除（`{ ids: [] }`） |
| POST | `/auth/accounts/batch-status` | 批量启停（`{ ids: [], status: "active"\|"disabled" }`） |

### 健康检查 & 配额

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/accounts/health-check` | 检查账号连通性（`{ ids?, stagger_ms?, concurrency? }`） |
| POST | `/auth/accounts/:id/refresh` | 刷新单个账号 token 和状态 |
| GET | `/auth/accounts/:id/quota` | 查看配额和用量 |
| POST | `/auth/accounts/:id/reset-usage` | 重置用量计数 |

### 导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/export` | 导出账号（`?ids=a,b&format=minimal`） |

### Cookies（Cloudflare）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/accounts/:id/cookies` | 获取已存 cookies |
| POST | `/auth/accounts/:id/cookies` | 设置 cookies（`{ cookies }`） |
| DELETE | `/auth/accounts/:id/cookies` | 清除 cookies |

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
| GET | `/admin/general-settings` | 获取全部设置 |
| POST | `/admin/general-settings` | 更新设置（返回 `restart_required` 标志） |
| GET | `/admin/settings` | 获取 proxy API key |
| POST | `/admin/settings` | 设置 proxy API key |
| GET | `/admin/rotation-settings` | 获取轮转策略 |
| POST | `/admin/rotation-settings` | 设置轮转策略 |
| GET | `/admin/quota-settings` | 获取配额设置 |
| POST | `/admin/quota-settings` | 更新配额设置 |

### 诊断

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康探针 → `{ status, authenticated, pool }` |
| POST | `/admin/test-connection` | 完整连通性诊断 |
| GET | `/debug/fingerprint` | TLS 指纹配置（仅 localhost） |
| GET | `/debug/diagnostics` | 系统诊断信息（仅 localhost） |
| GET | `/debug/models` | 模型存储内部状态 |

## 官方 Codex App Server Bridge

可选桥接到本机官方 `codex app-server`。这条路径用于复用官方 Codex app
插件能力，例如 Chrome/browser 插件。默认关闭：`official_agent.enabled:
false`。

以下端点强制要求独立的 `official_agent.api_key`；未配置该 key 时，桥接会拒绝请求。
不要复用 `server.proxy_api_key`，因为该桥接可以驱动本机 app-server 插件和审批流程。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/official-agent/apps` | 通过 `app/list` 列出官方 Codex apps/connectors |
| POST | `/official-agent/threads` | 创建 app-server thread（`{ model?, cwd? }`） |
| POST | `/official-agent/threads/:threadId/turns` | 发起 turn，并以 SSE 流式返回 app-server notifications |

turn 请求里的 `approvalPolicy` 如需传入，只允许 `untrusted`、`on-request`、
`on-failure`、`never`。

使用官方 Chrome app mention 的请求示例：

```json
{
  "text": "Open localhost:8080 and inspect the dashboard",
  "app": { "id": "chrome", "name": "Chrome" }
}
```

桥接层会发送一个 text item 和一个 `path: "app://{id}"` 的 `mention`
item。实际 app id 请先通过 `/official-agent/apps` 探测，不要默认硬编码。

### 更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/update-status` | 检查可用更新 |
| POST | `/admin/check-update` | 触发更新检查 |
| POST | `/admin/apply-update` | 执行自更新（SSE 进度流） |

### 用量统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/usage-stats/summary` | 按账号/模型的累计用量 |
| GET | `/admin/usage-stats/history` | 时序数据（`?granularity=hourly&hours=24`） |

### 配额告警

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/quota/warnings` | 当前活跃的配额告警 |

启用 `quota.skip_exhausted` 后，账号池会在获取账号时过滤缓存额度中
`rate_limit.limit_reached === true` 或
`secondary_rate_limit.limit_reached === true` 或
`code_review_rate_limit.limit_reached === true` 的 active 账号。过滤发生在
session affinity 之前，所以 `preferredEntryId` 不能把请求继续粘到已耗尽账号。
如果只是 `used_percent=99` 这类临近满额，但上游还没标记 `limit_reached`，代理
不会主动跳过；等上游返回 429 后，该账号会进入 `rate_limited` 退避并切换账号。
secondary / code review 窗口自己的 `reset_at` 过期后会从缓存中清除，避免账号被
永久跳过。

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
