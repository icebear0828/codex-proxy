# Test Suite Documentation

## Overview

Codex Proxy 综合测试套件，覆盖所有 API 格式、核心功能、伪装验证和并发压力。

**当前状态**: 500 tests / 36 test files / ~5500 行测试代码

```bash
npm test                         # 运行所有测试（unit + integration + e2e）
npm test -- --reporter=verbose   # 详细输出
npx vitest run --config tests/vitest.config.ts  # 单独运行 stress 测试
```

## 架构

```
tests/
├── _fixtures/              # 测试数据
│   ├── models.yaml         # 静态模型目录（4 模型 + 2 别名）
│   └── sse-streams.ts      # 预定义 SSE 事件序列（用于翻译层单元测试）
├── _helpers/               # 共享测试工具
│   ├── config.ts           # createMockConfig() / createMockFingerprint()
│   ├── e2e-setup.ts        # E2E 边界隔离层（mock transport + config + fs）
│   ├── events.ts           # ExtractedEvent 工厂（createTextDelta, createToolCallStart 等）
│   ├── format-adapter.ts   # FormatAdapter mock
│   ├── jwt.ts              # JWT 工厂（createValidJwt, createExpiredJwt）
│   └── sse.ts              # SSE 流构建器（buildTextStreamChunks 等 8 个）
├── unit/                   # 单元测试（纯函数 / 单模块）
├── integration/            # 集成测试（多模块协作）
├── e2e/                    # 端到端测试（真实 Hono app，仅 mock 外部边界）
└── stress/                 # 压力测试（并发 / 轮转公平性，独立 vitest 配置）
```

### E2E 测试架构

E2E 测试只 mock **外部边界**（TLS transport、文件系统、后台任务），内部所有模块真实运行：

```
[Test] → Hono App → Route → translateRequest → handleProxyRequest → CodexApi → [Mock Transport]
                      ↑ real                                             ↑ real       ↑ mocked
```

Mock 的模块：
- `@src/tls/transport.js` — 可控的 transport（`setTransportPost()` 注入响应）
- `@src/config.js` — 返回 `createMockConfig()`
- `@src/paths.js` — 返回 `/tmp/codex-e2e/` 路径
- `fs` — 拦截 models.yaml（从 fixture 读取）
- 后台任务（update-checker, self-update, model-fetcher）— no-op

真实运行的模块：
- AccountPool, CookieJar, ProxyPool, CodexApi
- 所有翻译层（openai-to-codex, codex-to-openai/anthropic/gemini）
- 所有中间件、所有路由、指纹管理器、模型存储

## 文件清单

### E2E 测试

#### `tests/e2e/chat-completions.test.ts` (22 tests, 704 lines)

POST `/v1/chat/completions` — OpenAI Chat Completions 格式

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | streaming: SSE 格式 | Content-Type: text/event-stream, chunk 有 object: "chat.completion.chunk", 以 [DONE] 结尾 |
| 2 | non-streaming: JSON 格式 | object: "chat.completion", choices[0].message.content |
| 3 | model name 解析 | "codex" 别名 → "gpt-5.4" |
| 4 | unauthenticated: 401 | error.code: "invalid_api_key" |
| 5 | invalid JSON: 400 | error.code: "invalid_json" |
| 6 | missing messages: 400 | error.code: "invalid_request" |
| 7 | upstream 429 | error.type: "rate_limit_error" |
| 8 | upstream 500 | 触发 withRetry（3 次调用），返回 error.type: "server_error" |
| 9 | model suffix: codex-fast | transport body model = gpt-5.4, response model = gpt-5.4-fast |
| 10 | tool calls (streaming) | SSE chunk 含 tool_calls delta（id, function.name, function.arguments），finish_reason: "tool_calls" |
| 11 | tool calls (non-streaming) | choices[0].message.tool_calls 数组，finish_reason: "tool_calls" |
| 12 | legacy function_call | functions[] + function_call: "auto" → proxy 翻译为 tools |
| 13 | image input | multimodal content (text + image_url) → transport body 含图片 |
| 14 | reasoning (streaming) | reasoning_effort: "high" → SSE chunk 含 reasoning_content delta |
| 15 | reasoning (non-streaming) | choices[0].message.reasoning_content 有值 |
| 16 | usage details | prompt_tokens_details.cached_tokens + completion_tokens_details.reasoning_tokens |
| 17 | model suffix: codex-high | effort 解析 + response model 含后缀 |
| 18 | model suffix: codex-high-fast | 双后缀：effort + service_tier |
| 19 | error 400: missing model | Zod 验证错误 |
| 20 | error 401: no accounts | 无账号时的认证拦截 |
| 21 | multiple tool calls (non-streaming) | 2 个 tool_calls 条目 |
| 22 | multiple tool calls (streaming) | SSE 含 2 个 function name |

#### `tests/e2e/messages.test.ts` (13 tests, 461 lines)

POST `/v1/messages` — Anthropic Messages 格式

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | streaming: text | message_start → content_block_start(text) → content_block_delta(text_delta) → content_block_stop → message_delta(end_turn) → message_stop |
| 2 | non-streaming: text | type: "message", role: "assistant", content[0].type: "text", stop_reason: "end_turn" |
| 3 | tool calls (non-streaming) | content block type: "tool_use", id, name, input（parsed JSON） |
| 4 | tool calls (streaming) | content_block_start(tool_use) → input_json_delta → stop_reason: "tool_use" |
| 5 | thinking (streaming) | thinking content block: content_block_start(thinking) → thinking_delta → text block |
| 6 | thinking (non-streaming) | content 数组：thinking block 在 text block 之前 |
| 7 | cache tokens | usage.cache_read_input_tokens |
| 8 | x-api-key auth | proxy_api_key: null 时正常通过 |
| 9 | unauthenticated: 401 | error.type: "authentication_error" |
| 10 | invalid JSON: 400 | error.type: "invalid_request_error" |
| 11 | missing messages: 400 | Zod 验证错误 |
| 12 | upstream 429 | error.type: "rate_limit_error" |
| 13 | upstream 500 | error.type: "api_error", 3 次 transport 调用 |

#### `tests/e2e/gemini.test.ts` (10 tests, 382 lines)

POST `/v1beta/models/{model}:streamGenerateContent` / `:generateContent` — Gemini 格式

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | streamGenerateContent: text | NDJSON SSE, candidates[0].content.parts[0].text, 末尾 finishReason: "STOP" + usageMetadata |
| 2 | generateContent: non-streaming | JSON 有 candidates, usageMetadata (promptTokenCount, candidatesTokenCount, totalTokenCount) |
| 3 | tool calls | parts 含 functionCall.name + functionCall.args |
| 4 | thinking | thinkingConfig.thinkingBudget 请求正常通过 |
| 5 | usage: cachedContentTokenCount | 从 cached_tokens 映射 |
| 6 | auth: unauthenticated | error.status: "UNAUTHENTICATED" |
| 7 | invalid action | /v1beta/models/codex:invalidAction → 400 |
| 8 | invalid JSON | 400 |
| 9 | upstream 429 | error.status: "RESOURCE_EXHAUSTED" |
| 10 | GET /v1beta/models | models 列表含 name, displayName, supportedGenerationMethods |

#### `tests/e2e/responses.test.ts` (8 tests, 286 lines)

POST `/v1/responses` — Codex Responses API 直通

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | streaming: SSE 直通 | 原始事件名（response.created, response.output_text.delta, response.completed），非 OpenAI 格式 |
| 2 | non-streaming: collect | JSON 为 Codex response 对象 |
| 3 | tool calls 直通 | SSE 含 response.output_item.added + response.function_call_arguments.done |
| 4 | model suffix parsing | codex-high-fast → model: gpt-5.4, effort: high |
| 5 | unauthenticated: 401 | error.code: "invalid_api_key" |
| 6 | invalid JSON: 400 | error.code: "invalid_json" |
| 7 | missing instructions: 400 | error.code: "invalid_request" |
| 8 | upstream 429 | error.type: "rate_limit_error" |

#### `tests/e2e/health-models.test.ts` (5 tests, 117 lines)

Health check + 模型端点

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | GET /health | status: "ok", authenticated: true, pool.total ≥ 1 |
| 2 | GET /v1/models | object: "list", 含 gpt-5.4 + codex 别名 |
| 3 | GET /v1/models/gpt-5.4 | id: "gpt-5.4", object: "model" |
| 4 | GET /v1/models/nonexistent | 404, error.code: "model_not_found" |
| 5 | GET /v1/models/catalog | 模型列表含 supportedReasoningEfforts |

### 集成测试

#### `tests/integration/account-routing.test.ts` (10 tests, 271 lines)

多账号路由逻辑

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | Plan-aware: 优选匹配 plan | plus 账号接 gpt-5.4 请求，free 被跳过 |
| 2 | Plan-aware: 无匹配返回 null | free 账号 + plan map 仅含 plus → null |
| 3 | Fallback: plan map 空 | 无 plan 约束时所有账号可用 |
| 4 | Least-used 轮转 | request_count 最少的优先 |
| 5 | Round-robin 轮转 | 配置切换后按序循环 |
| 6 | Rate limited 跳过 | 限流账号不被选中 |
| 7 | Rate limited 自动恢复 | backoff 到期后恢复 active |
| 8 | Stale lock 自动释放 | 5 分钟 TTL 后锁自动释放 |
| 9 | ExcludeIds | 排除指定账号 |
| 10 | Empty response 计数 | recordEmptyResponse 递增 empty_response_count |

#### `tests/integration/usage-passthrough.test.ts` (7 tests, 199 lines)

Token usage 透传（cached_tokens, reasoning_tokens）

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | OpenAI: cached_tokens | usage.prompt_tokens_details.cached_tokens |
| 2 | OpenAI: reasoning_tokens | usage.completion_tokens_details.reasoning_tokens |
| 3 | OpenAI: 两者同时 | 同时有 cached + reasoning |
| 4 | Anthropic: cache_read_input_tokens | 从 cached_tokens 映射 |
| 5 | Gemini: cachedContentTokenCount | 从 cached_tokens 映射 |
| 6 | OpenAI streaming: final chunk 含 usage | 末尾 chunk 有 prompt_tokens_details |
| 7 | Streaming vs non-streaming 一致性 | 两种模式 token 总量相同 |

#### `tests/integration/fingerprint.test.ts` (9 tests, 121 lines)

指纹头验证

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | sec-ch-ua 动态生成 | 匹配 chromium_version: "136" |
| 2 | User-Agent 模板替换 | {version}, {platform}, {arch} 替换正确 |
| 3 | Header 顺序 | 匹配 fingerprint.yaml header_order |
| 4 | originator 头 | "Codex Desktop" |
| 5 | Content-Type | buildHeadersWithContentType 含 application/json |
| 6 | Authorization | Bearer {token} |
| 7 | ChatGPT-Account-Id | 从 JWT 提取 |
| 8 | 匿名头无 Authorization | buildAnonymousHeaders 无认证头 |
| 9 | 默认头完整 | Accept-Encoding, Accept-Language, sec-fetch-* |

#### `tests/integration/proxy-handler.test.ts` (12 tests, 415 lines)

代理处理器生命周期

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 无账号 → 503 | formatNoAccount 被调用，release 不调用 |
| 2 | non-streaming 成功 | collectTranslator 返回 JSON，release 含 usage |
| 3 | streaming 成功 | text/event-stream + SSE chunks |
| 4 | 429 → markRateLimited | 不调用 release，只 markRateLimited |
| 5 | 4xx → formatError | release 调用，status 透传 |
| 6 | 5xx → formatError | release 调用，500 状态 |
| 7 | 非 CodexApiError → 500 | re-throw，release 调用 |
| 8 | EmptyResponseError → 换账号重试 | acquire 2 次，第 2 次成功 |
| 9 | Empty 重试耗尽 → 502 | recordEmptyResponse 调用 3 次 |
| 10 | 重试无账号 → 502 | "no other accounts are available" |
| 11 | 成功时 release 含 usage | 验证 usage 参数 |
| 12 | 错误时 release 无 usage | 验证 release(entryId) 无第二参数 |

#### `tests/integration/web-update.test.ts` (9 tests, 307 lines)

Web 更新路由

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | GET /admin/update-status 无缓存 | mode: "git", commits: [], update_available: false |
| 2 | 有缓存 commits | commits_behind: 2, commits 数组 |
| 3 | Docker 模式 release | release.version, release.body |
| 4 | POST /admin/check-update git | commits_behind: 1, update_available: true |
| 5 | check-update docker | release 信息 |
| 6 | check-update 错误处理 | error 字段，update_available: false |
| 7 | POST /admin/apply-update 成功 | started: true |
| 8 | apply-update 不可用 | 400, "not available" |
| 9 | apply-update 返回错误 | started: false, error 信息 |

### 单元测试

#### `tests/unit/auth/account-pool.test.ts` (16 tests, 278 lines)

账号池核心逻辑：添加/移除账号、acquire/release、JWT 解析、usage 追踪、窗口重置

#### `tests/unit/auth/jwt-utils.test.ts` (16 tests, 125 lines)

JWT 工具：decodeJwtPayload、extractChatGptAccountId、extractUserProfile、isTokenExpired

#### `tests/unit/auth/chatgpt-oauth.test.ts` (5 tests, 41 lines)

OAuth token 验证

#### `tests/unit/auth/refresh-scheduler.test.ts` (5 tests, 144 lines)

JWT 自动刷新调度：启动/停止、指数退避、恢复

#### `tests/unit/proxy/codex-api.test.ts` (13 tests, 174 lines)

Codex API client：createResponse、parseStream、getUsage、getModels、错误处理

#### `tests/unit/proxy/cookie-jar.test.ts` (10 tests, 107 lines)

Cookie 持久化：v2 格式、过期清理、per-account 隔离

#### `tests/unit/proxy/proxy-pool.test.ts` (43 tests, 486 lines)

代理池：添加/移除代理、URL 解析、健康检查、轮转策略、优先级

#### `tests/unit/translation/openai-to-codex.test.ts` (11 tests, 155 lines)

OpenAI → Codex 请求翻译：messages 转 input、system → instructions、tools、image content

#### `tests/unit/translation/codex-to-openai.test.ts` (11 tests, 132 lines)

Codex → OpenAI 响应翻译：text delta、tool calls、reasoning、usage、finish_reason

#### `tests/unit/translation/codex-to-anthropic.test.ts` (12 tests, 159 lines)

Codex → Anthropic 响应翻译：message_start/stop、content blocks、thinking、cache tokens

#### `tests/unit/translation/codex-to-gemini.test.ts` (9 tests, 121 lines)

Codex → Gemini 响应翻译：candidates、functionCall、usageMetadata、finishReason

#### `tests/unit/translation/gemini-to-codex.test.ts` (23 tests, 343 lines)

Gemini → Codex 请求翻译：contents → input、functionDeclarations → tools、thinkingConfig → reasoning

#### `tests/unit/translation/anthropic-to-codex.test.ts` (23 tests, 376 lines)

Anthropic → Codex 请求翻译：messages → input、system → instructions、tool_use blocks、thinking

#### `tests/unit/translation/codex-event-extractor.test.ts` (14 tests, 180 lines)

SSE 事件解析：iterateCodexEvents、ExtractedEvent 字段提取、EmptyResponseError

#### `tests/unit/translation/shared-utils.test.ts` (8 tests, 71 lines)

翻译层共享工具函数

#### `tests/unit/translation/tool-format.test.ts` (34 tests, 355 lines)

工具格式转换：OpenAI tools ↔ Codex tools、function_call 兼容、参数序列化

#### `tests/unit/types/openai-schemas.test.ts` (9 tests, 109 lines)

Zod schema 验证：ChatCompletionRequest、MessagesRequest 字段校验

#### `tests/unit/fingerprint/manager.test.ts` (12 tests, 103 lines)

指纹管理器：sec-ch-ua 生成、UA 模板、header 排序、认证头注入

#### `tests/unit/utils/jitter.test.ts` (6 tests, 45 lines)

随机抖动：范围验证、边界值

#### `tests/unit/utils/retry.test.ts` (6 tests, 56 lines)

重试逻辑：成功直接返回、指数退避、最大次数

#### `tests/unit/utils/yaml-mutate.test.ts` (6 tests, 119 lines)

YAML 原子写入：读取-修改-重命名、错误回滚

#### `tests/unit/config.test.ts` (7 tests, 133 lines)

配置加载：YAML 解析、热重载、默认值合并

#### `tests/unit/models/model-store.test.ts` (30 tests, 346 lines)

模型目录 + 别名 + 后缀解析

覆盖：
- 加载/别名解析：loadStaticModels, resolveModelId, getModelInfo
- 后缀解析: `-fast`, `-flex`, `-high`, `-xhigh`, `-low`, `-medium`, `-minimal`, `-none`, `-high-fast`, `-low-flex`（双后缀）
- 后端合并: applyBackendModels — 覆盖静态、保留静态独有、自动准入 Codex 兼容 ID
- Plan 追踪: `applyBackendModelsForPlan` + `getModelPlanTypes`
- Codex ID 过滤: `gpt-X.Y-codex-*` 和 `gpt-oss-*` 自动准入，`dall-e-3` / `whisper-1` 被过滤

#### `tests/unit/self-update.test.ts` (23 tests, 341 lines)

自更新系统：getProxyInfo、canSelfUpdate、getDeployMode、checkProxySelfUpdate（git/docker）、applyProxySelfUpdate

> **注意**: 3 个测试因 `self-update.ts` 源码变更而 failing，与本次测试新增无关

### Stress 测试

独立 vitest 配置（`tests/vitest.config.ts`），120s timeout，单 fork 运行。

#### `tests/stress/concurrent.test.ts` (5 tests, 228 lines)

并发压力测试（使用 E2E setup + mock transport）

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 10 并发 non-streaming | 全部 200，JSON 有效 |
| 2 | 10 并发 streaming | 全部 200，以 [DONE] 结尾 |
| 3 | 并发分配不同账号 | 3 账号均被使用 |
| 4 | 并发 + rate limit | 1 个 429 不影响其他请求 |
| 5 | 50 顺序请求吞吐 | 全部成功，总 request_count = 50 |

#### `tests/stress/account-rotation.test.ts` (2 tests, 86 lines)

轮转公平性 + 死锁检测

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 5 账号 100 次请求 | 每账号 ±5 次均匀分布 |
| 2 | 1000 次快速 acquire/release | 无死锁 |

### 共享工具

#### `tests/_helpers/sse.ts` (8 个 SSE 流构建器)

| 函数 | 用途 |
|------|------|
| `buildTextStreamChunks()` | 基础文本响应流 |
| `buildToolCallStreamChunks()` | 单个工具调用流 |
| `buildReasoningStreamChunks()` | 推理 + 文本流 |
| `buildDetailedUsageStreamChunks()` | 带 cached/reasoning tokens 的 usage |
| `buildErrorStreamChunks()` | 错误事件流 |
| `buildEmptyStreamChunks()` | 空响应流（触发 EmptyResponseError） |
| `buildMultiToolCallStreamChunks()` | 多工具调用流 |
| `mockResponse()` | 构建 Response 对象 |

#### `tests/_helpers/events.ts` (8 个事件工厂)

`createTextDelta`, `createReasoningDelta`, `createCreated`, `createCompleted`,
`createFunctionCallStart`, `createFunctionCallDelta`, `createFunctionCallDone`, `createError`, `createInProgress`

#### `tests/_helpers/config.ts`

`createMockConfig()`, `createMockFingerprint()` — 完整配置工厂，支持 overrides

#### `tests/_helpers/jwt.ts`

`createJwt()`, `createValidJwt()`, `createExpiredJwt()` — alg: "none" JWT 工厂

#### `tests/_helpers/format-adapter.ts`

`createMockFormatAdapter()` — FormatAdapter mock，支持 overrides

#### `tests/_helpers/e2e-setup.ts`

E2E 边界隔离层：`setTransportPost()`, `getLastTransportBody()`, `makeTransportResponse()`, `makeErrorTransportResponse()`

## 未覆盖（后续补充）

### Phase 3: 前端测试
- **组件单元测试**（`@testing-library/preact`）：Header, AccountCard, ApiConfig, ProxyPool, UpdateModal 等
- **Hook 测试**：useAccounts, useStatus, useProxies, useUpdateStatus
- **浏览器 E2E**（Playwright）：登录流程、模型选择、代理管理、主题切换、国际化

需要安装依赖：
```bash
npm install -D @testing-library/preact @testing-library/jest-dom  # 组件测试
npm install -D @playwright/test                                     # 浏览器 E2E
```

## 注意事项

- `tests/` 目录在 `.gitignore` 中，测试代码不入版本库
- 3 个 pre-existing 失败在 `self-update.test.ts`（与本次测试新增无关）
- E2E 测试每个 test case 重建 Hono app，避免 account lock 状态泄露
- 所有代码 **零 `any` 类型**，严格遵循项目 TypeScript 规范
