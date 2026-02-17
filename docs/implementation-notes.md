# Codex Proxy 实现记录

## 项目目标

将 Codex Desktop App（免费）的 API 访问能力提取出来，暴露为标准的 OpenAI `/v1/chat/completions` 兼容接口，使任何支持 OpenAI API 的客户端都能直接调用。

---

## 关键发现：WHAM API vs Codex Responses API

### 最初的方案（失败）

项目最初使用 **WHAM API**（`/backend-api/wham/tasks`）作为后端。这是 Codex Cloud 模式使用的 API，工作流程为：

1. 创建 cloud environment（需要绑定 GitHub 仓库）
2. 创建 task → 得到 task_id
3. 轮询 task turn 状态直到完成
4. 从 turn 的 output_items 中提取回复

**失败原因**：
- 免费账户没有 cloud environment
- `listEnvironments` 返回 500
- `worktree_snapshots/upload_url` 返回 404（功能未开启）
- 创建的 task 立即失败，返回 `unknown_error`

### 发现真正的 API

通过分析 Codex Desktop 的 CLI 二进制文件（`codex.exe`）中的字符串，发现 CLI 实际使用的是 **Responses API**，而不是 WHAM API。

进一步测试发现正确的端点是：

```
POST https://chatgpt.com/backend-api/codex/responses
```

#### 端点探索过程

| 端点 | 状态 | 说明 |
|------|------|------|
| `/backend-api/responses` | 404 | 不存在 |
| `api.openai.com/v1/responses` | 401 | ChatGPT token 没有 API scope |
| **`/backend-api/codex/responses`** | **400 → 200** | **正确端点** |

#### 必需字段（逐步试错发现）

1. 第一次请求 → `400: "Instructions are required"` → 需要 `instructions` 字段
2. 加上 instructions → `400: "Store must be set to false"` → 需要 `store: false`
3. 加上 store: false → `400: "Stream must be set to true"` → 需要 `stream: true`
4. 全部加上 → `200 OK` ✓

---

## API 格式

### 请求格式

```json
{
  "model": "gpt-5.1-codex-mini",
  "instructions": "You are a helpful assistant.",
  "input": [
    { "role": "user", "content": "你好" }
  ],
  "stream": true,
  "store": false,
  "reasoning": { "effort": "medium" }
}
```

**关键约束**：
- `stream` 必须为 `true`（不支持非流式）
- `store` 必须为 `false`
- `instructions` 必填（对应 system message）

### 响应格式（SSE 流）

Codex Responses API 返回标准的 OpenAI Responses API SSE 事件：

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_xxx","status":"in_progress",...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"你","item_id":"msg_xxx",...}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"好","item_id":"msg_xxx",...}

event: response.output_text.done
data: {"type":"response.output_text.done","text":"你好！",...}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_xxx","status":"completed","usage":{...},...}}
```

主要事件类型：
- `response.created` — 响应开始
- `response.in_progress` — 处理中
- `response.output_item.added` — 输出项添加（reasoning 或 message）
- `response.output_text.delta` — **文本增量（核心内容）**
- `response.output_text.done` — 文本完成
- `response.completed` — 响应完成（包含 usage 统计）

### 认证方式

使用 Codex Desktop App 的 ChatGPT OAuth JWT token，需要以下请求头：

```
Authorization: Bearer <jwt_token>
ChatGPT-Account-Id: <account_id>
originator: Codex Desktop
User-Agent: Codex Desktop/260202.0859 (win32; x64)
Content-Type: application/json
Accept: text/event-stream
```

---

## 代码实现

### 新增文件

#### `src/proxy/codex-api.ts` — Codex Responses API 客户端

负责：
- 构建请求并发送到 `/backend-api/codex/responses`
- 解析 SSE 流，逐个 yield 事件对象
- 错误处理（超时、HTTP 错误等）

```typescript
// 核心方法
async createResponse(request: CodexResponsesRequest): Promise<Response>
async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent>
```

#### `src/translation/openai-to-codex.ts` — 请求翻译

将 OpenAI Chat Completions 请求格式转换为 Codex Responses API 格式：

| OpenAI Chat Completions | Codex Responses API |
|------------------------|---------------------|
| `messages[role=system]` | `instructions` |
| `messages[role=user/assistant]` | `input[]` |
| `model` | `model`（经过 resolveModelId 映射） |
| `reasoning_effort` | `reasoning.effort` |
| `stream` | 固定 `true` |
| — | `store: false`（固定） |

#### `src/translation/codex-to-openai.ts` — 响应翻译

将 Codex Responses SSE 流转换为 OpenAI Chat Completions 格式：

**流式模式** (`streamCodexToOpenAI`)：
```
Codex: response.output_text.delta {"delta":"你"}
  ↓
OpenAI: data: {"choices":[{"delta":{"content":"你"}}]}

Codex: response.completed
  ↓
OpenAI: data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
OpenAI: data: [DONE]
```

**非流式模式** (`collectCodexResponse`)：
- 消费整个 SSE 流，收集所有 text delta
- 拼接为完整文本
- 返回标准 `chat.completion` JSON 响应（包含 usage）

### 修改文件

#### `src/routes/chat.ts` — 路由处理器（重写）

**之前**：使用 WhamApi 创建 task → 轮询 turn → 提取结果
**之后**：使用 CodexApi 发送 responses 请求 → 直接流式/收集结果

核心流程简化为：
```
1. 验证认证
2. 解析请求 (ChatCompletionRequestSchema)
3. translateToCodexRequest() 转换格式
4. codexApi.createResponse() 发送请求
5a. 流式：streamCodexToOpenAI() → 逐块写入 SSE
5b. 非流式：collectCodexResponse() → 返回 JSON
```

#### `src/index.ts` — 入口文件（简化）

移除了 WHAM environment 自动发现逻辑（不再需要）。

---

## 之前修复的 Bug（WHAM 阶段）

在切换到 Codex Responses API 之前，还修复了 WHAM API 相关的三个 bug：

1. **`turn_status` vs `status` 字段名不匹配** — WHAM API 返回 `turn_status`，但代码检查 `status`，导致轮询永远不匹配，超时 300 秒
2. **`getTaskTurn` 响应结构嵌套** — API 返回 `{ task, user_turn, turn }` 但代码把整个响应当作 `WhamTurn`，导致 `output_items` 为 `undefined`
3. **失败的 turn 返回 200 空内容** — 没有检查 `failed` 状态，直接返回空 content

这些修复在 `src/types/wham.ts`、`src/proxy/wham-api.ts`、`src/translation/stream-adapter.ts` 中。

---

## 测试结果

### 非流式请求
```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.1-codex-mini","messages":[{"role":"user","content":"Say hello"}]}'
```
```json
{
  "id": "chatcmpl-3125ece443994614aa7b1136",
  "object": "chat.completion",
  "choices": [{"message": {"role": "assistant", "content": "Hello!"}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 22, "completion_tokens": 20, "total_tokens": 42}
}
```
响应时间：~2 秒

### 流式请求
```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.1-codex-mini","messages":[{"role":"user","content":"Say hello"}],"stream":true}'
```
```
data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":"!"}}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}}]}
data: [DONE]
```
首 token 时间：~500ms

---

## 文件结构总览

```
src/
├── proxy/
│   ├── codex-api.ts      ← 新增：Codex Responses API 客户端
│   ├── client.ts          （通用 HTTP 客户端，保留）
│   └── wham-api.ts        （WHAM 客户端，保留但不再使用）
├── translation/
│   ├── openai-to-codex.ts ← 新增：Chat Completions → Codex 格式
│   ├── codex-to-openai.ts ← 新增：Codex SSE → Chat Completions 格式
│   ├── openai-to-wham.ts  （旧翻译器，保留）
│   ├── stream-adapter.ts  （旧流适配器，保留）
│   └── wham-to-openai.ts  （旧翻译器，保留）
├── routes/
│   └── chat.ts            ← 重写：使用 Codex API
├── index.ts               ← 简化：移除 WHAM env 逻辑
└── ...
```
