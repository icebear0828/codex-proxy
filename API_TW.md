# Codex Proxy API 文件

[English](./API.md) | [简体中文](./API_CN.md) | **繁體中文 (台灣)** | [繁體中文 (香港)](./API_HK.md) | [日本語](./API_JA.md)

---

## 鑑權方式

所有代理端點（chat / messages / gemini / responses / embeddings / images）均支援設定好的代理 API Key：
- 請求標頭：`Authorization: Bearer {proxy_api_key}`、`x-api-key: {proxy_api_key}` 或 `x-goog-api-key: {proxy_api_key}`
- 查詢參數：`?key={proxy_api_key}`

### 客戶端子金鑰（Client Keys / Sub-keys）
客戶端亦可使用在後台管理面板或 Admin API 建立的細粒度 Client Key 進行認證。子金鑰支援配額上限（USD 預算）、Token 上限、並發上限、允許存取的模型清單以及過期時間。
- 子金鑰自我查詢端點：`GET /v1/sub-key/info`（需要傳入 `Authorization: Bearer {client_key}`）。

### Dashboard 與管理介面鑑權
- Dashboard 管理面板使用 cookie session（`_codex_session`）。
- 管理介面（`/admin/*`）要求有效的 Dashboard session，或透過 `Authorization: Bearer {master_api_key}` 傳入主 Proxy API Key。

---

## API 代理端點

### POST /v1/chat/completions
OpenAI 相容的聊天補全介面。

```jsonc
// 請求體
{
  "model": "gpt-5.6-sol",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // 可選: low | medium | high | xhigh
}
```

- 串流：SSE，事件包含 `choice.delta`
- 非串流：`{ id, choices, usage }`
- 錯誤格式：`{ error: { message, type, code } }`
- `max_tokens`、`max_completion_tokens`、`max_output_tokens` 僅做客戶端相容解析，不會轉發給 Codex 原生後端。

### POST /v1/messages
Anthropic Messages API 相容介面。

```jsonc
// 請求體
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled"}  // 可選
}
```

- 鑑權：`x-api-key` 或 `Authorization: Bearer`
- 錯誤格式：`{ type: "error", error: { type, message } }`

### POST /v1beta/models/:model:generateContent
### POST /v1beta/models/:model:streamGenerateContent
Google Gemini 相容介面。

```jsonc
// 請求體
{
  "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  "systemInstruction": {"parts": [{"text": "你是一個有用的助手。"}]}
}
```

- 鑑權：`x-goog-api-key` 請求標頭、`key` 查詢參數、或 Bearer token
- 錯誤格式：`{ error: { code, message, status } }`

### POST /v1/responses
原生 Codex Responses API 直通（HTTP POST + SSE）。

```jsonc
// 請求體
{
  "model": "gpt-5.6-sol",
  "instructions": "你是一個有用的助手。",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // 多輪對話上下文延續
}
```

- 串流：SSE 事件 `response.created`、`response.output_text.delta`、`response.completed`
- 非串流：`{ response, usage, responseId }`
- 請勿向原生 Codex 發送 `max_output_tokens`。代理僅做相容解析並予以剔除，因為真實 Codex 後端會回傳 `400 Unsupported parameter: max_output_tokens` 錯誤。

### WebSocket /v1/responses
原生 Codex Responses API WebSocket 傳輸（Issue #681）。

客戶端可透過 WebSocket 連線至 `ws://{host}:{port}/v1/responses`（或 `wss://`），並攜帶標準認證資訊（如 `Authorization: Bearer {key}` 標頭或 `?key={key}` 查詢參數）。

- 連線維持長連，支援多輪對話互動。
- 客戶端發送 `response.create` 格式的 JSON 文字訊框。
- 代理執行請求並將 SSE 的 `data:` JSON 負載逐訊框回傳給客戶端。

### POST /v1/images/generations
OpenAI Images API 相容的圖片生成介面。

```jsonc
// 請求體
{
  "model": "gpt-image-2",
  "prompt": "雪山日落的壯麗風景",
  "size": "1024x1024",
  "output_format": "png"
}
```

- 代理將圖像生成請求轉換為 Codex Responses 的 `image_generation` 工具調用，並路由至設定的 `model.image_host_model`（預設：`gpt-5.5`）。
- 回傳 OpenAI 相容格式 `{ created, data: [{ b64_json, revised_prompt }] }`。

### POST /v1/embeddings
OpenAI 相容的文本向量嵌入（Embeddings）介面。

```jsonc
// 請求體
{
  "model": "text-embedding-3-small",
  "input": "在此輸入文字字串"
}
```

- 路由至設定了 `embeddings` 能力的第三方 Provider API Key。
- 回傳 `{ object: "list", data: [{ object: "embedding", embedding: [...], index: 0 }], model, usage }`。

---

### Codex 輔助端點

`POST /v1/alpha/search` 支援由 ChatGPT OAuth 帳號池承載的一般 Codex 模型，並將請求轉送至 `/backend-api/codex/alpha/search`。對於 OAuth Search，除 401/429 外的一般 4xx 會直接回傳，不改變帳號健康狀態，也不清除 Cookie；只有明確識別出的 Cloudflare challenge 才會進入安全的冷卻換號流程。當請求模型路由到 `wire=codex-responses` 的 API-key provider 時，代理亦支援下列全部非串流 JSON 端點：

| 端點 | 上游目標 | 用途 |
|---|---|---|
| `POST /v1/alpha/search` | `<baseUrl>/alpha/search` | Codex CLI 獨立 Web 搜尋 |
| `POST /v1/responses/compact` | `<baseUrl>/responses/compact` | 遠端對話壓縮（Compaction） |
| `POST /v1/images/generations` | `<baseUrl>/images/generations` | Codex JSON 圖片生成 |
| `POST /v1/images/edits` | `<baseUrl>/images/edits` | Codex JSON 圖片編輯 |

所有端點均要求 body 含非空 `model`，並使用現有模型路由。OAuth 搜尋會重用帳號池的 Cookie、代理選擇、重試/輪替和 Codex 請求上下文；API-key 路由則以供應商 API Key 替換本地代理鑑權。除已設定的模型別名、內部 provider 前綴解析及下述 Responses Lite 正規化外，不改寫 JSON body，並原樣回傳上游狀態碼、Content-Type 與回應主體。未列入白名單的路徑不會被轉發。亦接受不帶 `/v1` 的本地別名。遠端壓縮的公開合約見 [OpenAI Responses compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact/)；獨立搜尋路徑來自 [Codex CLI 0.147.0 官方原始碼](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/codex-api/src/endpoint/search.rs#L31-L45)。

對於 Responses 生成及 compact 請求，當請求含 `x-openai-internal-codex-responses-lite: true`，或 `client_metadata` 內含等效 WebSocket 標記時，代理會套用完整 Responses Lite 合約：強制 `reasoning.context=all_turns`、`parallel_tool_calls=false`。這可能增加保留上下文及 token 用量，並使工具呼叫依序執行，但可避免 Lite 標記與請求 body 不一致而被上游拒絕。

#### image_generation 工具

在 `tools[]` 內宣告 `{"type": "image_generation", ...}`，模型即可呼叫伺服端圖像生成後端（`gpt-image-2`）。前提：**ChatGPT Plus 及以上** 帳號——free 帳號上游會靜默剝除工具，模型會改用 SVG 文字替代繪圖。

**支援欄位**（除 `type` 外全部為選填）：

| 欄位 | 列舉 / 範圍 | 預設值 | 備註 |
|---|---|---|---|
| `size` | `1024x1024`、`1024x1536`、`1536x1024`、`2048x2048`、`2048x3072`、`3072x2048`、`3840x2160`（4K UHD）、`2160x3840`（4K 直式）、`2304x3072`（3:4）、`auto` | `auto` | 寬高必須均為 16 的倍數；最長邊 ≤ 3840 px；總像素預算約 8 MP（`3072x3072` 會被拒絕）；低於 1024 px 解析度亦會被拒（最小像素預算）|
| `output_format` | `png` / `jpeg` / `webp` | `png` | `gif` 會被拒絕 |
| `output_compression` | 整數 0–100 | `100` | **僅 jpeg / webp 生效** — png 下非 100 會報錯 |
| `background` | `auto` / `opaque` | `auto` | `transparent` 在此模型下會被拒絕 |
| `moderation` | `auto` / `low` | `auto` | 其他列舉值會被拒絕 |
| `partial_images` | 整數 0–3 | 0 | `>3` 會被拒絕 |

**靜默改寫 / 明確拒絕的欄位**：

- `model` — 無論傳入什麼，上游強制改回 `gpt-image-2`（回應回顯為 `gpt-image-2-codex`）。
- `size` — 客戶端請求的 `2048x2048`、`2K`、`4K` 等尺寸會被上游回顯/正規化為 `auto`，實際輸出解析度由伺服端自行決定（例如實測 `1254x1254`）。
- `quality` — 傳入任何值均被 echo 為 `auto`，使用者自訂值不生效。
- `n` — `unknown_parameter`；一次只能產生一張圖片。
- `input_image`、`mask`、`input_fidelity`、`style`、`response_format` — 全部拒絕。

**事件順序**（模型呼叫工具時）：

1. `response.created` — `tools[]` 被上游補齊預設欄位並回顯。
2. `response.output_item.added` — `{type: "image_generation_call", ...}`。
3. `response.image_generation_call.in_progress` → `.generating` → （可選）`.partial_image` × N。
4. `response.output_item.done` — 完整的 `image_generation_call`：
   - `result` — base64 圖像（格式依 `output_format`）。
   - `revised_prompt` — 模型實際採用的最終提示詞。
5. `response.completed`。

**Token 計費**：`response.completed.response.usage` 為主模型的 token；圖像工具的 token 單獨透過 `response.completed.response.tool_usage.image_gen.{input_tokens, output_tokens, total_tokens}` 回傳。代理兩端均原樣直通，並在儀表板中將圖像 token 單列為 `total_image_input_tokens` / `total_image_output_tokens`，不會與主模型的 token 混淆。

**請求計數**：代理同時分別統計圖像生成的成功 / 失敗次數。`total_image_request_count` 在上游回傳真實圖像（`tool_usage.image_gen.output_tokens > 0`）時 +1；`total_image_request_failed_count` 在工具被靜默剝除（Free 帳號）、上游錯誤、空回應等任何失敗路徑下 +1。兩者皆透過 `/admin/usage-stats/summary` 公開，Dashboard 的「Image Requests」卡片直接展示 `N ok · M failed`。

**編輯模式**（附帶參考圖）：在 user message 的 content 陣列中加入 `input_image` 區塊，`data:` URL 與 HTTPS URL 均支援。

```jsonc
{
  "model": "gpt-5.6-sol",
  "stream": true,
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "把這張圖的天空改成黃昏。"},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA...", "detail": "high"}
    ]
  }],
  "tools": [{"type": "image_generation", "size": "1024x1024"}]
}
```

合法 content-part 類型（由上游列舉校驗回顯）：`input_text`、`input_image`、`output_text`、`refusal`、`input_file`、`computer_screenshot`、`summary_text`。

OpenAI Chat 相容路徑會接受 `tools: [{"type":"image_generation"}]`，但穩定的圖像 payload 僅會透過 `/v1/responses` 的 `image_generation_call.result` 暴露。需要獲取 base64 圖片位元組時，請使用 `/v1/responses` 或 `POST /v1/images/generations`。

---

### Ollama 相容橋接

可選橋接服務運行於獨立的監聽連接埠上，預設為 `http://127.0.0.1:11434`。預設處於關閉狀態，可透過控制面板或 Admin API 開啟。Ollama 端點設計為免認證，除非您信任當前網路環境，否則建議僅綁定在本地回環位址（localhost）。

瀏覽器 CORS 存取被限制在本地回環來源（`localhost`、`127.x.x.x`、`::1`），非本地網頁預設無法讀取橋接回應。橋接層在轉發 `/v1/*` 請求時會自動注入設定好的 Codex Proxy API Key，因此向區域網路或公網暴露該連接埠等同於免密碼暴露代理主介面。

| 方法 | 路徑 | 說明 |
|--------|------|-------------|
| GET | `/api/version` | 版本探測 → `{ version }` |
| GET | `/api/tags` | Ollama 格式的模型清單 |
| POST | `/api/show` | 模型中繼資料與能力描述 |
| POST | `/api/chat` | 聊天補全介面（預設 NDJSON 串流） |
| Any | `/v1/*` | OpenAI 相容直通主代理 |

```jsonc
// POST http://127.0.0.1:11434/api/chat
{
  "model": "codex",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "think": "medium"  // 可選: false | true | low | medium | high | xhigh
}
```

支援的請求欄位映射：

| Ollama 欄位 | 上游 OpenAI 對應欄位 |
|--------------|-----------------------|
| `messages[].images` | `content[].image_url` data URLs |
| `tools` | `tools` |
| `think` | `reasoning_effort` |
| `format: "json"` | `response_format: { type: "json_object" }` |
| `format: { ... }` | 嚴格 JSON schema 格式 |
| `options.temperature` | `temperature` |
| `options.top_p` | `top_p` |
| `options.num_predict` | `max_tokens` |

---

## 模型

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/v1/models` | 列出所有模型（OpenAI 格式，帶 Client Key 時會自動按權限過濾） |
| GET | `/v1/models/catalog` | 完整模型目錄（含 reasoning effort 及中繼資料） |
| GET | `/v1/models/:id` | 單一模型詳細資訊 |
| GET | `/v1/models/:id/info` | 擴充模型資訊 |
| GET | `/v1beta/models` | 列出模型（Gemini 格式） |
| POST | `/admin/refresh-models` | 強制從上游重新整理模型清單 |

模型目錄條目可以包含 token 中繼資料：

| 欄位 | 含義 |
|------|------|
| `contextWindow` | 靜態或上游提供的上下文視窗，用於展示和客戶端參考 |
| `maxContextWindow` | 上游提供的最大可擴展上下文視窗（若有回傳） |
| `maxOutputTokens` | 靜態或上游提供的最大輸出 token，用於展示和客戶端參考 |
| `truncationPolicyLimit` | 上游提供的截斷策略限制（若有回傳） |
| `outputModalities` | 支援的輸出模態（例如 `["text"]`、`["text", "image"]`） |

靜態值定義於 `config/models.yaml`；同一模型 ID 若從 `/backend-api/codex/models` 取得動態條目，則以上游動態值為準。

---

## 客戶端子金鑰管理（Client Keys）

透過子金鑰可以產生帶有特定額度、模型權限、Token 限制、並發控制和過期時間的獨立 API Key。

### 自我查詢端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/v1/sub-key/info` | 查詢當前 Client Key 的配額、剩餘額度、允許模型和用量數據 |

### 管理員介面

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/client-keys` | 列出所有 Client Keys（去識別化/遮罩）及彙總統計 |
| POST | `/admin/client-keys` | 建立新 Client Key（`{ name, key?, expires_at?, max_budget_usd?, max_tokens?, max_concurrency?, allowed_models?, default_tools? }`） |
| PUT | `/admin/client-keys/:id` | 更新 Client Key 設定 |
| POST | `/admin/client-keys/:id/toggle` | 快速啟用 / 停用金鑰（`active` / `disabled`） |
| POST | `/admin/client-keys/:id/reset-usage` | 重設指定金鑰的用量花費與 Token 計數 |
| DELETE | `/admin/client-keys/:id` | 刪除 Client Key |

---

## 帳號管理

### CRUD

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/accounts` | 列出所有帳號、持久化健康狀態與備援上游狀態 |
| POST | `/auth/accounts` | 新增單一帳號（`{ token?, refreshToken? }`） |
| DELETE | `/auth/accounts/:id` | 刪除帳號 |
| PATCH | `/auth/accounts/:id/label` | 設定標籤（`{ label }`） |
| PATCH | `/auth/accounts/:id/codex-fingerprint` | 設定帳號 TLS 指紋模式（`{ mode: "off" | "session" }`） |

### 批次操作

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/auth/accounts/import` | 批次匯入（`{ accounts: [{token?, refreshToken?, label?}] }` 或純文字格式） |
| POST | `/auth/accounts/batch-delete` | 批次刪除（`{ ids: [] }`） |
| POST | `/auth/accounts/batch-status` | 批次啟用/停用（`{ ids: [], status: "active" | "disabled" }`） |

### 健康檢查 & 配額

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/auth/accounts/health-check` | 檢查帳號連通性（`{ ids?, stagger_ms?, concurrency? }`） |
| POST | `/auth/accounts/:id/refresh` | 重新整理單一帳號 token 和狀態 |
| GET | `/auth/accounts/:id/quota` | 查看配額與用量 |
| POST | `/auth/accounts/:id/reset-usage` | 重設用量計數 |
| GET | `/auth/accounts/:id/reset-credits` | 查看 Reset Credits 資訊 |
| POST | `/auth/accounts/:id/reset-credits/consume` | 消耗 Reset Credit（`{ redeem_request_id? }`） |

### 匯出

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/accounts/export` | 匯出帳號（`?ids=a,b&format=minimal|full|csv|token-key|auth-json|sub2api`） |

### Cookies（Cloudflare）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/accounts/:id/cookies` | 取得已存 cookies |
| POST | `/auth/accounts/:id/cookies` | 設定 cookies（`{ cookies }`） |
| DELETE | `/auth/accounts/:id/cookies` | 清除 cookies |

### 備援上游 API-Key（Fallback Upstream）

當所有 OAuth 帳號均不可用（過期、遭限流或帳號池為空）時，代理會自動路由至設定的備援上游 API Key。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/fallback-upstream` | 取得備援上游設定與狀態 |
| POST | `/auth/fallback-upstream` | 設定備援上游（`{ baseUrl, apiKey }`） |
| PUT | `/auth/fallback-upstream` | 更新備援上游（`{ baseUrl, apiKey? }`） |
| DELETE | `/auth/fallback-upstream` | 清除備援上游設定 |

---

## 第三方 Provider API Key 管理

管理第三方供應商的 API Key（Anthropic、OpenAI、Gemini、OpenRouter、Custom 等）。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/api-keys` | 列出所有已設定的 Provider API Keys |
| GET | `/auth/api-keys/catalog` | 取得預定義模型目錄 |
| POST | `/auth/api-keys/models` | 從上游供應商拉取可用模型清單 |
| GET | `/auth/api-keys/export` | 匯出 API Keys 以便重新匯入 |
| POST | `/auth/api-keys/import` | 批次匯入 Provider API Keys（`{ keys: [] }`） |
| POST | `/auth/api-keys` | 新增單一 Provider Key 綁定（`{ provider, models, apiKey, baseUrl?, label?, capabilities?, wire? }`） |
| POST | `/auth/api-keys/batch-delete` | 批次刪除 API Keys（`{ ids: [] }`） |
| DELETE | `/auth/api-keys/:id` | 刪除單一 API Key |
| PATCH | `/auth/api-keys/:id/label` | 修改 Key 標籤（`{ label }`） |
| PATCH | `/auth/api-keys/:id/status` | 修改 Key 狀態（`{ status: "active" | "disabled" }`） |

---

## OAuth & 登入

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/auth/login-start` | 發起 OAuth → 回傳 `{ authUrl, state }` |
| GET | `/auth/login` | 302 重新導向至 Auth0 |
| POST | `/auth/code-relay` | OAuth 授權碼交換（`{ callbackUrl }`） |
| GET | `/auth/callback` | OAuth 回調處理 |
| POST | `/auth/device-login` | 發起設備碼流程 |
| GET | `/auth/device-poll/:deviceCode` | 輪詢設備授權狀態 |
| POST | `/auth/import-cli` | 從 Codex CLI auth.json 匯入 |
| POST | `/auth/token` | 手動提交 token |
| GET | `/auth/status` | 認證狀態 + 帳號池概要 |
| POST | `/auth/logout` | 清空所有帳號 |

---

## 代理池管理

### CRUD

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/proxies` | 列出所有代理（含健康狀態與分配） |
| POST | `/api/proxies` | 新增代理（`{ url }` 或 `{ host, port, username, password }`） |
| PUT | `/api/proxies/:id` | 更新代理 |
| DELETE | `/api/proxies/:id` | 刪除代理 |

### 健康檢查 & 控制

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/proxies/:id/check` | 檢查單一代理 |
| POST | `/api/proxies/check-all` | 檢查所有代理 |
| POST | `/api/proxies/:id/enable` | 啟用代理 |
| POST | `/api/proxies/:id/disable` | 停用代理 |

### 分配（帳號 ↔ 代理）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/proxies/assignments` | 列出所有分配關係 |
| POST | `/api/proxies/assign` | 分配代理給帳號（`{ accountId, proxyId }`） |
| DELETE | `/api/proxies/assign/:accountId` | 取消分配 |
| POST | `/api/proxies/assign-bulk` | 批次分配（`{ assignments: [] }`） |
| POST | `/api/proxies/assign-rule` | 按規則自動分配（`{ rule: "round-robin", ... }`） |

### 匯入/匯出

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/proxies/export` | 匯出為 YAML |
| POST | `/api/proxies/import` | 匯入 YAML 或純文字（`host:port:user:pass` 格式） |
| GET | `/api/proxies/assignments/export` | 匯出分配關係 |
| POST | `/api/proxies/assignments/import` | 預覽分配匯入（不執行） |
| POST | `/api/proxies/assignments/apply` | 套用分配匯入 |

### 設定

| 方法 | 路徑 | 說明 |
|------|------|------|
| PUT | `/api/proxies/settings` | 更新健康檢查間隔 |

---

## 管理 & 設定

### 通用設定

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/general-settings` | 取得全部 server / tls / model / logs 設定 |
| POST | `/admin/general-settings` | 更新設定（回傳 `restart_required` 標誌） |
| GET | `/admin/settings` | 取得 Master proxy API key |
| POST | `/admin/settings` | 設定 Master proxy API key |
| GET | `/admin/rotation-settings` | 取得輪轉策略 |
| POST | `/admin/rotation-settings` | 設定輪轉策略（`least_used` | `round_robin` | `sticky`） |
| GET | `/admin/quota-settings` | 取得配額與跳過設定 |
| POST | `/admin/quota-settings` | 更新配額與跳過設定 |
| GET | `/admin/ollama-settings` | 取得 Ollama Bridge 設定及運行狀態 |
| POST | `/admin/ollama-settings` | 持久化 Ollama Bridge 設定並重啟橋接 |
| GET | `/admin/ollama-status` | 取得 Ollama Bridge 運行狀態 |

### 診斷

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/health` | 健康探針 → `{ status, authenticated, pool, uptime_seconds }` |
| POST | `/admin/test-connection` | 完整連通性診斷（伺服器、帳號、傳輸層、上游） |
| GET | `/debug/fingerprint` | TLS 指紋設定（僅限 localhost） |
| GET | `/debug/diagnostics` | 系統診斷資訊與檔案路徑（僅限 localhost） |
| GET | `/debug/models` | 模型存儲內部狀態 |

### 請求日誌

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/logs` | 查詢擷取的請求日誌清單（`?limit=&offset=&direction=&search=`） |
| GET | `/admin/logs/state` | 取得請求日誌儲存狀態（`enabled`, `paused`, `capacity`） |
| POST | `/admin/logs/state` | 更新日誌擷取狀態（`{ enabled?, paused? }`） |
| POST | `/admin/logs/clear` | 清空所有記憶體請求日誌 |
| GET | `/admin/logs/:id` | 取得單條日誌詳細內容 |

### 錯誤日誌

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/error-logs` | 取得彙總後的錯誤日誌清單 |
| GET | `/admin/error-logs/raw` | 取得原始錯誤日誌清單（`?limit=`） |
| GET | `/admin/error-logs/count` | 取得總錯誤數與未讀錯誤數 |
| POST | `/admin/error-logs/seen` | 標記錯誤日誌已讀游標 |
| DELETE | `/admin/error-logs` | 清空錯誤日誌 |
| POST | `/admin/error-logs/report` | 上報客戶端錯誤（`{ source, error: { name, message, stack }, context? }`） |

### 官方 Codex App Server Bridge

可選橋接至本機官方 `codex app-server`。用於復用官方 Codex app 外掛程式能力（如 Chrome/browser 外掛程式）。預設關閉（`official_agent.enabled: false`）。強制要求獨立的 `official_agent.api_key`。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/official-agent/apps` | 透過 `app/list` 列出官方 Codex apps/connectors |
| POST | `/official-agent/threads` | 建立 app-server thread（`{ model?, cwd? }`） |
| POST | `/official-agent/threads/:threadId/turns` | 發起 turn，並以 SSE 串流回傳 app-server notifications |

### 更新

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/update-status` | 檢查可用更新 |
| POST | `/admin/check-update` | 觸發更新檢查 |
| POST | `/admin/apply-update` | 執行自我更新（SSE 進度串流） |

### 用量統計

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/admin/usage-stats/summary` | 按帳號/模型/Client Key 維度的累計用量 |
| GET | `/admin/usage-stats/history` | 時序數據（`?granularity=raw|five_min|hourly|daily&hours=24|all`） |

### 配額告警

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/auth/quota/warnings` | 當前活躍的配額告警 |

啟用 `quota.skip_exhausted` 後，帳號池會在取得帳號時過濾快取額度中 `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true` 或 `code_review_rate_limit.limit_reached === true` 的 active 帳號。過濾發生在 session affinity 之前，所以 `preferredEntryId` 不能將請求繼續粘附在已耗盡帳號。若只是 `used_percent=99` 這類逼近上限但上游尚未標記 `limit_reached` 的情況，代理不會主動跳過；等上游回傳 429 後，該帳號會進入 `rate_limited` 退避並自動切換至其他可用帳號。

---

## Dashboard 認證

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/auth/dashboard-login` | 密碼登入 → 設定 session cookie（限流：5次/分鐘） |
| POST | `/auth/dashboard-logout` | 登出 |
| GET | `/auth/dashboard-status` | 檢查是否需要登入 |

---

## 錯誤格式

各協議回傳各自原生的錯誤結構：

| 協議 | 格式 |
|------|------|
| OpenAI | `{ error: { message, type, code, param } }` |
| Anthropic | `{ type: "error", error: { type, message } }` |
| Gemini | `{ error: { code, message, status } }` |
| Responses | `{ type: "error", error: { type, code, message } }` |
| Admin | `{ error: "..." }` |

常見 HTTP 狀態碼：`401`（未認證）、`429`（限流）、`503`（無可用帳號）。
