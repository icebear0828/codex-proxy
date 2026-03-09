# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [Unreleased]

### Added

- 更新弹窗 + 自动重启：点击"有可用更新"弹出 Modal 显示 changelog，一键更新后服务器自动重启、前端自动刷新，零人工干预（git 模式 spawn 新进程、Docker/Electron 显示对应操作指引）

### Fixed

- Docker 端口修复：锁定容器内 `PORT=8080`（`environment` 覆盖 `env_file`），HEALTHCHECK 固定检查 8080，`.env` 的 PORT 仅控制宿主机暴露端口，修复自定义 PORT 时健康检查失败和端口映射不匹配的问题 (#40)
- Docker Compose 暴露 OAuth 回调端口 1455，修复容器内登录时 "Operation timed out" 的问题
- README Docker 快速开始补充 `cp .env.example .env` 步骤，修复新用户因缺少 `.env` 文件导致 `docker compose up -d` 启动失败的问题 (#38)
- 识别 `response.output_item.done`、`response.incomplete`、`response.queued` Codex SSE 事件，消除 "Unknown event" 日志噪音
- 剥离 `service_tier` 字段：Codex 后端不接受请求体中的 `service_tier`，现在 proxy 在发送前自动移除，修复 `-fast` 后缀导致 "Unsupported service_tier" 报错
- 更新 gpt-5.4 推理等级：`minimal` → `none`，新增 `xhigh`（与后端实际支持的值对齐）
- 添加 `OpenAI-Beta` 请求头：与 Codex Desktop 保持一致（`responses_websockets=2026-02-06`）
- 流式 SSE 请求不再设置 `--max-time` 墙钟超时，修复思考链（reasoning/thinking）在 60 秒处中断的问题；连接保护由 header 超时 + AbortSignal 提供，非流式请求（models、usage）超时不受影响

### Added

- `/v1/responses` 端点：Codex Responses API 直通，无格式转换，支持原始 SSE 事件流和多账号负载均衡

- 模型名后缀系统：通过模型名嵌入推理等级和速度模式（如 `gpt-5.4-high-fast`），CLI 工具（Claude Code、opencode 等）无需额外参数即可控制推理强度和 Fast 模式
- `service_tier` 后缀解析：通过 `-fast`/`-flex` 模型名后缀解析，保留在 proxy 层元数据中（Codex 后端不接受 `service_tier` 请求体字段，Desktop 在 app-server 层处理）
- Dashboard Speed 切换：模型选择器下方新增 Standard / Fast 速度切换按钮

- 代理分配管理页面（`#/proxy-settings`）：双栏矩阵式布局，批量管理数百账号的代理分配
  - 左栏代理组列表：按 Global/Direct/Auto/各代理分组显示计数徽章，点击筛选
  - 右栏账号表格：搜索、状态筛选、分页（50条/页）、Shift+点击连续多选、每行独立代理下拉
  - 批量操作栏：批量设为指定代理、均匀分配到所有活跃代理（round-robin）、按规则分配
  - 导入导出：导出 JSON 分配文件、导入后预览 diff 再确认应用
  - Hash 路由零依赖切换，Header 导航链接（Dashboard ↔ 代理分配）
  - 后端新增 6 个批量 API：assignments 列表/批量分配/规则分配/导出/导入预览/应用导入

- 代理池功能：支持为不同账号配置不同的上游代理，实现 IP 多样化和风险隔离
  - 代理 CRUD：添加、删除、启用、禁用代理（HTTP/HTTPS/SOCKS5）
  - 四种分配模式：Global Default（全局代理）、Direct（直连）、Auto（Round-Robin 轮转）、指定代理
  - 健康检查：定时（默认 5 分钟）+ 手动，通过 ipify API 获取出口 IP 和延迟
  - 不可达代理自动标记为 unreachable，不参与自动轮转
  - Dashboard 代理池管理面板：添加/删除/检查/启用/禁用代理
  - AccountCard 代理选择器：每个账号可选择代理或模式
  - 全套 REST API：`/api/proxies` CRUD + `/api/proxies/assign` 分配管理
  - 持久化：`data/proxies.json`（原子写入，与 cookies.json 同模式）
  - Transport 层支持 per-request 代理：`TlsTransport` 接口新增可选 `proxyUrl` 参数
- Dashboard GitHub Star 徽章：Header 新增醒目的 ⭐ Star 按钮（amber 药丸样式），点击跳转 GitHub 仓库页面，方便用户收藏和获取更新
- Dashboard 检查更新功能：Footer 显示 Proxy 版本+commit 和 Codex Desktop 指纹版本，提供"检查更新"按钮同时检查两种更新
  - Proxy 自更新（CLI 模式）：通过 `git fetch` 检查新提交，自动执行 `git pull + npm install + npm run build`，完成后提示重启
  - Codex 指纹更新：手动触发现有 appcast 检查，自动应用指纹/模型配置变更
  - Docker 兼容：指纹可自动更新，代理代码提示手动 `docker compose up -d --build`
  - Electron 兼容：显示版本信息，更新由桌面应用管理
- `GET /admin/update-status` 端点：返回 proxy 和 codex 两种更新的当前状态
- `POST /admin/check-update` 端点：同时触发 proxy 自检 + codex 指纹检查，自动应用可用更新
- `src/self-update.ts`：Proxy 自更新模块（git 子进程实现，支持检查/拉取/构建）
- GPT-5.4 + Codex Spark 模型支持：新增 `gpt-5.4`（4 种 effort: minimal/low/medium/high）和 `gpt-5.3-codex-spark`（minimal/low），`codex` 别名更新为 `gpt-5.4`
- 扩展推理等级：支持 `minimal`、`xhigh` 等新 effort 值，客户端发送的任意 `reasoning_effort` 均透传到后端
- 模型家族矩阵选择器：Dashboard 模型选择从平面下拉改为家族列表 + 推理等级按钮组，通过 `/v1/models/catalog` 端点获取完整目录
- 泛化模型识别：`isCodexCompatibleId()` 同时匹配 `gpt-X.Y-codex-*` 和裸 `gpt-X.Y` 格式，确保新模型命名规范变化时自动接入
- 代码示例动态 reasoning_effort：CodeExamples 组件根据选中的推理等级自动插入 `reasoning_effort` 参数
- Reasoning/Thinking 输出支持：始终向 Codex API 发送 `summary: "auto"` 以获取推理摘要事件；OpenAI 路由在客户端发送 `reasoning_effort` 时以 `reasoning_content` 输出；Anthropic 路由在客户端发送 `thinking.type: enabled/adaptive` 时以 thinking block 输出；未知 SSE 事件记录到 debug 日志以便发现新事件类型
- 图片输入支持：OpenAI、Anthropic、Gemini 三种格式的图片内容现在可以正确透传到 Codex 后端（`input_image` + data URI），此前图片被静默丢弃
- 每窗口使用量计数器：Dashboard 主显示当前窗口内的请求数和 Token 用量，累计总量降为次要灰色小字；窗口过期时自动归零（时间驱动，零 API 开销），后端同步作为双保险校正
- 窗口时长显示：从后端同步 `limit_window_seconds`，AccountCard header 显示窗口时长 badge（如 `3h`），重置时间行追加窗口时长文字
- Dashboard 账号列表新增手动刷新按钮：点击重新拉取额度数据，刷新中按钮旋转并禁用；独立 `refreshing` 状态确保刷新时列表不清空；标题行右侧显示"更新于 HH:MM:SS"时间戳（桌面端可见）
- 空响应计数器：每个账号追踪 `empty_response_count`，通过 `GET /auth/accounts` 可查看，窗口重置时自动归零
- 空响应日志增强：日志中显示账号邮箱（`Account xxxx (email) | Empty response`），便于定位问题账号
- 空响应检测 + 自动换号重试：Codex API 返回 HTTP 200 但无内容时，非流式自动切换账号重试（最多 3 次），流式注入错误提示文本
- 自动提取 Chromium 版本：`extract-fingerprint.ts` 从 `package.json` 读取 Electron 版本，通过 `electron-to-chromium` 映射为 Chromium 大版本，`apply-update.ts` 自动更新 `chromium_version` 和 TLS impersonate profile
- 动态模型列表：后台从 Codex 后端自动获取模型目录，与静态 YAML 合并（`src/models/model-store.ts`、`src/models/model-fetcher.ts`）
- `/debug/models` 诊断端点，展示模型来源（static/backend）与刷新状态
- 完整 Codex 模型目录：GPT-5.3/5.2/5.1 全系列 base/high/mid/low/max/mini 变体（23 个静态模型）
- OpenCode 平台支持（`opencode.json` 配置文件）
- Vitest 测试框架（account-pool、codex-api、codex-event-extractor 单元测试）
- request-id 中间件注入全局请求链路 ID
- Dockerfile 安全加固（非 root 用户运行、HEALTHCHECK 探针）

### Changed

- Dashboard 模型选择器去重：移除 Anthropic SDK Setup 的独立模型下拉框，统一使用 API Configuration 的 Default Model
- 模型管理从纯静态 YAML 迁移至静态+动态混合架构（后端优先，YAML 兜底）
- 默认模型改为 `gpt-5.2-codex`
- Dashboard "Claude Code Quick Setup" 重命名为 "Anthropic SDK Setup"
- `/health` 端点精简，仅返回 pool 摘要（total / active）

### Fixed

- Anthropic 路由 `thinking`/`redacted_thinking` content block 验证失败：Claude Code `/compact` 发送含 extended thinking 的对话历史时触发 400 Zod 错误，现已添加到 schema
- Anthropic 路由上下文 token 始终显示 0%：`message_delta` 事件缺少 `input_tokens`，Claude Code 无法计算上下文占比，现在从 `response.completed` 提取后一并返回
- 工具 schema 缺少 `properties` 字段导致 400 错误：MCP 工具发送 `{"type":"object"}` 无 `properties` 时，Codex 后端拒绝请求；现在所有格式转换器（OpenAI/Anthropic/Gemini）统一注入 `properties: {}`（PR #22）
- 额度窗口刷新后 Dashboard 仍显示累计 Token：本地计数器从未按窗口重置，现在 `refreshStatus()` 每次 acquire/getAccounts 时检查 `window_reset_at`，过期自动归零窗口计数器
- 空响应重试循环中账号双重释放：外层 catch 使用原始 `entryId` 而非当前活跃账号，导致换号重试失败时 double-release（`proxy-handler.ts`）
- `apply-update.ts` 模型比较不再误报删除：静态提取只含 2 个硬编码模型，与 YAML 的 24 个比较会产生 22 个假删除，现在只报新增
- `update-checker.ts` 子进程超时保护：`fork()` 添加 5 分钟 kill timer，防止挂起导致 `_updateInProgress` 永久锁定
- `model-fetcher.ts` 初始定时器添加 try/finally，防止异常中断刷新循环
- `apply-update.ts` 移除 `any` 类型（`mutateYaml` 回调参数）
- `ExtractedFingerprint` 接口统一：提取到 `scripts/types.ts` 共享，`extract-fingerprint.ts` 和 `apply-update.ts` 共用
- 强化提示词注入防护：`SUPPRESS_PROMPT` 从弱 "ignore" 措辞改为声明式覆盖（"NOT applicable"、"standard OpenAI API model"），解决 mini 模型仍泄露 Codex Desktop 身份的问题
- 非流式请求错误处理：`collectTranslator` 抛出 generic Error 时返回 502 JSON 而非 500 HTML（`proxy-handler.ts`）
- `desktop-context.md` 提取损坏修复：`extractPrompts()` 的 end marker 从 `` `; `` 改为 `` `[,;)] `` 正则，防止压缩 JS 代码注入 instructions 导致 tool_calls 失效（#13）
- 清除 `config/prompts/desktop-context.md` 中第 71 行起被污染的 ~7KB JS 垃圾代码
- TLS 伪装 profile 确定性解析：用已知 Chrome profile 列表（`KNOWN_CHROME_PROFILES`）替代不可靠的 runtime 检测，确保 `--impersonate` 目标始终有效（如 `chrome137` → `chrome136`）
- FFI transport 硬编码 `"chrome136"` 改为使用统一解析的 profile（`getResolvedProfile()`）
- `getModels()` 死代码：`allModels` 作用域修复，消除不可达分支
- `reloadAllConfigs()` 异步 lazy import 改为同步直接导入，避免日志时序不准
- 模型合并 reasoning efforts 判断逻辑从 `length > 1` 改为显式标志
- `scheduleNext()` 添加 try/finally 防止异常中断刷新循环
- 未认证启动时抑制无意义的 warn 日志
- `getModelCatalog()` / `getModelAliases()` 返回浅拷贝，防止外部意外修改
- `ClaudeCodeSetup.tsx` 文件名与导出名不一致，重命名为 `AnthropicSetup.tsx`
- Dashboard 模型偏好从硬编码 `gpt-5.2-codex` 改为使用 `codex` 别名
- 构建脚本 `vite build --root web` 兼容性问题，改用 `npm run build:web`
- Docker 容器内代理自动检测失败：`detectLocalProxy()` 现在同时探测 `127.0.0.1`（裸机）和 `host.docker.internal`（Docker 容器→宿主机），零配置即生效

## [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

### Added

- 原生 function_call / tool_calls 支持（所有协议）

### Fixed

- 格式错误的 chat payload 返回 400 `invalid_json` 错误

## [v0.7.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.7.0) - 2026-02-22

### Added

- `developer` 角色支持（OpenAI 协议）
- 数组格式 content 支持
- tool / function 消息兼容（所有协议）
- 模型响应中自动过滤 Codex Desktop 指令

### Changed

- 清理无用代码、未使用配置，修复类型违规

### Fixed

- 启动日志显示配置的 `proxy_api_key` 而非随机哈希
- 首次 OAuth 登录后 `useStatus` 未刷新

## [v0.6.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.6.0) - 2026-02-21

### Added

- libcurl-impersonate FFI 传输层，Chrome TLS 指纹
- pnpm / bun 包管理器支持

### Changed

- README 快速开始按平台重组

### Fixed

- Docker 构建完整修复链（代理配置、BuildKit 冲突、host 网络、源码复制顺序、layer 优化）
- `.env` 行内注释被误解析为 JWT token
- Anthropic / Gemini 代码示例跟随所选模型
- `proxy_api_key` 配置未在前端和认证验证中使用
- 删除按钮始终可见，不被状态徽章遮挡

## [v0.5.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.5.0) - 2026-02-20

### Added

- Dashboard 暗色 / 亮色主题切换
- 国际化支持（中文 / 英文）
- 自动代理检测（mihomo / clash / v2ray）
- 局域网登录分步教程
- Preact + Vite 前端架构
- Docker 容器部署支持
- 共享代理处理器，消除路由重复

### Changed

- Dashboard 重写为 Tailwind CSS
- 协议 / 语言两级标签页（OpenAI / Anthropic / Gemini × Python / cURL / Node.js）
- 内联 SVG 图标替换字体图标
- 系统字体替换 Google Fonts
- 架构审计修复（P0-P2 稳定性与可靠性）

### Fixed

- 移除所有 `any` 类型
- 修复图标文字闪烁（FOUC）
- 修复未认证时的重定向循环
- 移除虚假的 Claude / Gemini 模型别名，使用动态目录
- Dashboard 配置改为只读，修复 HTTP 复制按钮
- 恢复模型下拉选择器

## [v0.4.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.4.0) - 2026-02-19

### Added

- Anthropic Messages API 兼容路由（`POST /v1/messages`）
- Google Gemini API 兼容路由
- 桌面端上下文注入（模拟 Codex Desktop 请求特征）
- 多轮对话会话管理
- 自动更新检查管道（Appcast 轮询 + 版本提取）
- 中英双语 README

## [v0.3.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.3.0) - 2026-02-18

### Added

- curl-impersonate TLS 指纹模拟
- Chromium 版本自动检测与动态 `sec-ch-ua` 生成
- 请求时序 jitter 随机化
- Dashboard 实时代码示例与配额显示

### Fixed

- curl 请求修复

## [v0.2.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.2.0) - 2026-02-17

### Added

- Dashboard 多账户管理 UI
- OAuth PKCE 登录流程（固定 `localhost:1455` 回调）
- 架构审计：伪装加固、自动更新机制、健壮性提升

### Changed

- 硬编码值提取到配置文件
- 清理无用代码

## [v0.1.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.1.0) - 2026-02-17

### Added

- OpenAI `/v1/chat/completions` → Codex Responses API 反向代理核心
- 配额 API 查询（`/auth/accounts?quota=true`）
- Cloudflare TLS 指纹绕过
- SSE 流式响应转换
- 模型列表端点（`GET /v1/models`）
- 健康检查端点（`GET /health`）
