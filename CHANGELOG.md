# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [Unreleased]

### Added

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
