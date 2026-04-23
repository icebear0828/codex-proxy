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
