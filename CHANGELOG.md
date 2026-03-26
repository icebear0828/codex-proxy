# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [Unreleased]

### Removed

- 删除废弃的 `packages/electron/desktop/` UI（Electron 已直接加载 web/ UI），消除 18 个重复组件
- 删除 `public-desktop/` 构建产物目录及 `/desktop` 路由
- 删除 `web/src/` 中 6 个未被引用的死文件（hooks/utils/i18n/theme，~443 LOC）

### Changed

- 提取 `src/proxy/error-classification.ts`：`isBanError`/`isTokenInvalidError`/`isModelNotSupportedError`/`extractRetryAfterSec` 从 proxy-handler 和 usage-refresher 中去重，19 个新测试
- `scripts/` 按用途分类到 `infra/`、`build/`、`poc/`、`manual-test/` 子目录
- 新增 `src/context.ts`（AppContext 容器），fingerprint/manager、codex-api、codex-usage、codex-models 支持可选 DI 参数（fallback 到全局单例）
- `ModelStore` 从模块级单例重构为 class，自由函数 wrapper 保持后向兼容，新增 `getModelStore()` / `setModelStoreForTesting()`
- Transport 加入 AppContext，codex-api/codex-usage/codex-models/proxy-pool/curl-fetch 支持可选 transport 注入
- CookieJar critical cookie 写入从 `writeFileSync`（阻塞 10-50ms）改为 `writeFile`（async 非阻塞）
- `proxy-handler.ts`（353 LOC）拆分为 3 个独立可测试模块：`account-acquisition.ts`（acquire/release + 幂等 guard）、`proxy-error-handler.ts`（4 种错误分类 + 池状态变更）、`response-processor.ts`（流式/非流式响应），26 个新测试
- `AccountPool`（673 LOC）拆分为 `AccountRegistry`（状态 + CRUD + 查询，423 LOC）+ `AccountLifecycle`（锁 + 轮换，154 LOC），facade 219 LOC 编排。37 个 importer 零改动
- `model-fetcher.ts` 和 `usage-refresher.ts` 从模块级单例重构为 `ModelFetcher` / `UsageRefresher` class，自由函数 wrapper 保持后向兼容

### Fixed

- 导入/导出按钮图标反了——导入改为下箭头、导出改为上箭头（#191）
- Windows 桌面端按钮溢出——Electron 最小宽度从 680px 提高到 800px，覆盖 Tailwind md: 断点（#192）
- `local.yaml` 的 `server.host` 覆盖已有测试验证，Electron 模式下正确生效（#190）

### Changed

- 版本号从 1.0.x 跳到 2.0.0，CI bump workflow 改为从 package.json 读取 major.minor 系列

- **Phase 3 — Service 层提取**：`src/routes/accounts.ts` 从 518 行降至 172 行（-67%），业务逻辑拆分到 `src/services/account-import.ts`、`account-query.ts`、`account-mutation.ts` 三个 service 类，全部通过 constructor DI，29 个新测试零 `vi.mock()`
- **Phase 2 — Config DI**：`src/config.ts` 新增 `setConfigForTesting()`/`resetConfigForTesting()`，AccountPool constructor 支持 `rotationStrategy`/`initialToken`/`rateLimitBackoffSeconds` 注入，translation 函数支持 `modelConfig` 可选参数。测试中 `vi.mock("config.js")` 从 9 处降至 2 处
- AccountList 头部重做：标题行 + 导航标签 + 操作工具栏三层分离，按钮带文字标签，分页信息更清晰（`10 / 908` + 展开全部）
- 暗色主题修复：图表 SVG 线条颜色改用 CSS 变量（dark mode 下更亮）、代码块 light mode 背景修正、Toggle 开关 thumb 对比度提升

### Added

- 账号标签（label）：支持为每个账号设置自定义标签（如 "Team Alpha"、"个人"），解决同一邮箱加入多个 team 无法区分的问题。AccountCard 有标签时显示标签为主标题，hover 显示编辑按钮
- Refresh-token-only 导入：批量导入现在支持只传 `refreshToken`（无需有效 JWT），后端自动用 RT 换取 AT 后添加账号
- 导入模板下载：AccountImportExport 工具栏新增模板下载按钮，包含 token-only、RT-only、label 等示例格式
- 导入支持 label 字段：批量导入时可为每条记录指定 label
- Claude Code Setup 卡片：Dashboard 按 Opus/Sonnet/Haiku/自定义 层级一键复制环境变量（推荐模型 gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex）
- 账号启用/禁用 toggle：AccountCard 和 AccountTable 新增 per-account 开关，无需批量操作即可快速切换账号状态
- Codex CLI 配置说明：README 新增 `~/.codex/config.toml` 配置示例
- Token 刷新并发控制（`auth.refresh_concurrency`，默认 2）：多账号同时到期时限制并发数，避免上游限流
- Dashboard 基础设置新增「刷新并发数」配置项
- README 添加局域网访问说明（`0.0.0.0` 配置 + Electron 路径）

### Fixed

- Electron 模式下 `data/local.yaml` 中的 `server.host` 配置不生效——Electron 硬编码 `127.0.0.1` 覆盖了用户配置，现在 `local.yaml` 显式设置的 host 优先于启动参数（#175）
- Dashboard 清空上游代理后 reload 被环境变量 `HTTPS_PROXY` 覆盖回来——`local.yaml` 显式设置的 `proxy_url` 现在优先于环境变量
- Release 资产命名统一：`artifactName` 模板强制 `Codex-Proxy-{version}-{os}-{arch}.{ext}`，消除 `Codex.Proxy` vs `Codex-Proxy` 重复，x64 DMG 现在明确标注架构（`mac-x64`）
- macOS x64 构建前清理旧资产，避免 release 页面出现重复文件

### Changed

- TLS 指纹对齐：curl-impersonate 升级支持 chrome144 profile（v1.5.1），`KNOWN_CHROME_PROFILES` 新增 133/142
- 默认协议从 HTTP/1.1 改为 HTTP/2，匹配真实 Codex Desktop 行为
- 指纹版本同步至 v26.318.11754（build 1100）
- 配额自动刷新默认关闭（`refresh_interval_minutes: 0`），用户在 Dashboard 自行设置
- 配额刷新改为有限并发（默认 10，可配 `quota.concurrency`），不再全量并发
- Token 刷新走账号分配的代理，永久错误需连续 2 次才标 expired
- **⚠️ 密钥变更**：首次启动自动创建 `data/local.yaml` 并设置默认密钥 `pwd`。所有自定义配置请通过 Dashboard 修改（自动保存到 `data/local.yaml`，更新不覆盖）
- `suppress_desktop_directives` 默认值改为 `false`

### Added

- Dashboard「基础设置」面板：端口、代理、HTTP/1.1、默认模型、推理等级、注入/压制、Token 刷新开关
- Dashboard「配额设置」面板：新增并发数配置
- 代理池 YAML 导入导出（`/api/proxies/export`、`/api/proxies/import`）
- 账号列表分页（默认显示 10 个，可展开）
- Token 自动刷新开关（`auth.refresh_enabled`）
- HTTP/2 自动降级：curl 因 H2 错误失败时自动切换 HTTP/1.1（TTL 10 分钟后重试 H2）
  - exit code 16（H2 专属）无条件触发；其他 exit code 需 stderr 含 H2 关键词
  - `force_http11` 配置仍可手动强制 HTTP/1.1

### Fixed

- 配置 overlay 机制：Dashboard 设置写入 `data/local.yaml`（gitignored），不再修改 `config/default.yaml`
  - `git pull` 不会覆盖用户自定义设置（proxy_api_key、rotation_strategy、quota 等）
  - `config/default.yaml` 的 `proxy_api_key` 默认值改为 `null`（自动生成）

### Fixed

- 额度恢复后账号仍显示"已限速"（#162）
  - usage-refresher 发现 `limit_reached: false` 时主动调用 `clearRateLimit()` 恢复 active 并清除 `rate_limit_until`
- Anthropic `/v1/messages` 截图场景 400 报错：`tool_result.content` 不支持 image block
  - Schema 放行 image block；翻译层将图片提取为紧随 `function_call_output` 的 user message（`input_image`）
- 代理自动检测使用 `host.docker.internal` 主机名导致 curl 无法解析（#114）
  - 探测成功后通过 DNS lookup 解析为 IP 地址，避免 curl subprocess DNS 解析失败
- OAuth 登录失败后重试报 "Invalid or expired session"（#154）
  - Session 改为 peek → exchange 成功 → delete 生命周期，exchange 失败时 session 保留可重试
- `withDirectFallback` 未捕获 curl exit code 5（代理解析失败），不会 fallback 直连
  - `isProxyNetworkError` 新增 `could not resolve proxy` 和 `curl exited with code 5` 匹配
- curl error 61：fingerprint 的 `Accept-Encoding: br, zstd` 覆盖了 `--compressed` 自动协商，系统 curl 不支持 br/zstd 时解压失败
  - curl-cli-transport 统一跳过 `Accept-Encoding` header，由 `--compressed` 按 curl 实际能力协商
- 系统 curl 不支持 `--compressed` 时启动报错
  - 启动时探测支持情况，不支持则跳过该 flag 并提示安装 curl-impersonate
- 模型列表启动时不更新：token 刷新与 model fetch 存在竞态，初始 fetch 跳过后直接等 1 小时
  - model-fetcher 改为 fast-retry（10s 间隔，最多 12 次），账号就绪后立即拉取
  - `config/models.yaml` 补回 gpt-5.4/5.4-mini/5.3-codex（3/18 后端已恢复）

### Added

- Dashboard 登录门（#141）：当 `proxy_api_key` 已配置且请求来自非 localhost 时，需输入密码才能访问控制台
  - Cookie-based session，TTL 由 `session.ttl_minutes` 控制（默认 60 分钟）
  - `POST /auth/dashboard-login`、`POST /auth/dashboard-logout`、`GET /auth/dashboard-status` 端点
  - API 路由（`/v1/*`）不受影响，Electron（localhost）自动跳过
  - 简单防暴力：同 IP 5 次/60s 限制
  - HTTPS 自动检测：反代 `X-Forwarded-Proto: https` 时 cookie 加 `Secure` flag
  - 远程 session 禁止清空 `proxy_api_key`（防止误操作导致登录门失效）
  - Header 显示条件性退出按钮
- 账号封禁检测：上游返回非 Cloudflare 的 403 时自动标记为 `banned` 状态
  - Dashboard 卡片/表格显示玫红色 `Banned`/`已封禁` 状态徽章
  - 状态筛选下拉新增 `Banned` 选项
  - 被封账号自动跳过（`acquire()` 仅选 active），请求时自动切换到其他账号
  - 后台额度刷新周期性重试 banned 账号，成功即自动解封
- 上游 401 token 吊销（"token has been invalidated"）自动标记过期并切换下一个账号
  - 之前 401 直接透传给客户端，不标记也不重试
- Usage Stats 页面（`#/usage-stats`）：累计 token 用量汇总 + 时间趋势图
  - 后台每 5 分钟记录用量快照，保留 7 天历史
  - `GET /admin/usage-stats/summary` 实时累计汇总
  - `GET /admin/usage-stats/history?granularity=hourly|daily&hours=N` 时间序列增量
  - 纯 SVG 折线图（input/output tokens + 请求数），无外部图表库
  - 支持按小时/按天粒度，24h/3d/7d 时间范围切换
- Account Management 页面（`#/account-management`）：批量删除、批量改状态（active/disabled）、导入导出
  - `POST /auth/accounts/batch-delete` 和 `POST /auth/accounts/batch-status` 批量端点
  - 状态摘要条可点击筛选，复用 AccountTable 选择/分页/Shift 多选

### Fixed

- 运行时缓存（模型目录同步、版本检测结果）直接写入 git 跟踪的 `config/` 文件，导致仓库频繁变脏
  - `model-store` 的 `syncStaticModels()` 改写 `data/models-cache.yaml`（gitignored）
  - `update-checker` 的 `applyVersionUpdate()` 改写 `data/version-state.json`（gitignored）
  - `config/` 目录现在对运行时操作只读，仅 admin API 设置变更例外

- Responses SSE 新事件（`response.output_item.added` with `item.type=message`、`response.content_part.added/done`）未被识别，导致 `[CodexEvents] Unknown event` 日志刷屏
- 新模型（如 `gpt-5.4-mini`）无法被动态发现的问题
  - 移除 `isCodexCompatibleId()` 白名单过滤，信任后端 `/codex/models` 返回
- 同一 Team 的多个账号因共享 `chatgpt_account_id` 只能添加一个的问题（#126）
  - 去重逻辑改为 `accountId + userId` 组合键，Team 成员各自保留独立条目
  - `AccountEntry` 新增 `userId` 字段，持久化层自动回填
- 额度耗尽账号仍显示「活跃」并接收请求的问题（#115）
  - `markQuotaExhausted()` 现在可以覆盖 `rate_limited` 状态（仅延长，不缩短 reset 时间）
  - 后台额度刷新现在同时检查 `rate_limited` 账号，防止因 429 短暂 backoff 导致漏检
- `/v1/responses` 不再强制要求 `instructions` 字段，未传时默认空字符串（#71）
  - 修复 Cherry 等第三方客户端不传 `instructions` 时返回 400 的兼容性问题
- CI 构建修复：WebSocket 传输 `instructions` 类型不匹配（TS2322）导致 Electron/Docker 编译失败
- `shared/i18n/translations.ts` 移除中英文重复 `selectAll` key（Vite 警告）
- `sync-changelog.yml` 推送步骤加 rebase 重试（解决与 bump-electron 并行推送竞态）

### Changed

- 架构重构：降低模块耦合、改善可测试性
  - 提取 `codex-types.ts`：API 类型定义与类实现分离，20+ 文件只需类型不需类
  - 提取 `rotation-strategy.ts`：轮换策略从 AccountPool 解耦为纯函数模块（10 新测试）
  - 拆分 `web.ts`（605 LOC）→ `routes/admin/`（health/update/connection/settings 4 子路由）
  - 提取 `account-persistence.ts`：文件系统持久化逻辑从 AccountPool 分离为可注入接口（8 新测试）
  - 拆分 `codex-api.ts`：SSE 解析（`codex-sse.ts`）、用量查询（`codex-usage.ts`）、模型发现（`codex-models.ts`）独立为纯函数模块（10 新测试）
  - 所有提取模块通过 re-export 保持现有 import 路径兼容

### Added

- Sticky rotation strategy（#107）：新增 `sticky` 账号轮换策略，持续使用同一账号直到限速或额度耗尽
  - `src/config.ts`：`rotation_strategy` 枚举新增 `"sticky"` 选项
  - `selectByStrategy()` 按 `last_used` 降序排列，优先复用最近使用的账号
  - `GET/POST /admin/rotation-settings` 端点：读取和更新轮换策略（支持 Bearer auth）
  - Dashboard：RotationSettings 组件（粘滞 vs 轮换两层 radio group）
  - i18n：中英文翻译（策略名称 + 描述）
  - 13 个新测试覆盖 sticky 选择逻辑 + 路由端点
- `POST /admin/refresh-models` 端点：手动触发模型列表刷新，解决 model-fetcher ~1h 缓存过时导致新模型不可用的问题；支持 Bearer auth（当配置 proxy_api_key 时）
- Plan routing integration tests：通过 proxy handler 完整路径验证 free/team 账号的模型路由（7 cases），覆盖 plan map 更新后请求解除阻塞的场景

### Changed

- Electron 桌面端从独立分支迁移为 npm workspace（`packages/electron/`），消除 master→electron 分支同步冲突；删除 `sync-electron.yml`，release.yml 改为 workspace 感知构建
- `scripts/setup-curl.ts`：加入 GITHUB_TOKEN 认证避免 CI rate limit；Windows DLL 名适配 v1.5+（`libcurl-impersonate.dll`）；tar 解压 bsdtar/GNU tar 自动 fallback

### Added

- Dashboard 额度设置面板：可在 Web UI 直接调整额度刷新间隔、主/次预警阈值、自动跳过耗尽账号开关，无需手动编辑 YAML；API `GET/POST /admin/quota-settings` 支持鉴权 (#92)

### Fixed

- 删除账号后额度预警横幅未清除：`DELETE /auth/accounts/:id` 漏调 `clearWarnings()`，导致已删除账号的 quota warning 残留在前端 (#100)
- macOS Electron 桌面版登录报 `spawn Unknown system error -86`：CI 在 arm64 runner 上同时构建 arm64/x64 DMG，但只下载 arm64 的 curl-impersonate，导致 Intel Mac 用户 spawn 失败（EBADARCH）；拆分为 per-arch 构建 + `setup-curl.ts` 支持 `--arch` 交叉下载；错误提示改为明确的架构不匹配诊断 (#96)
- 默认关闭 desktop context 注入：之前每次请求注入 ~1500 token 的 Codex Desktop 系统提示，导致 prompt_tokens 虚高；新增 `model.inject_desktop_context` 配置项（默认 `false`），需要时可手动开启 (#95)

### Added

- 额度自动刷新 + 分层预警：后台每 5 分钟（可配置）定时拉取所有账号的官方额度，缓存到 AccountEntry 供 Dashboard 即时读取；额度达到阈值（默认 80%/90%，可自定义）时显示 warning/critical 横幅；额度耗尽的账号自动标记为 rate_limited 跳过分配，到期自动恢复 (#92)
- Docker 镜像自动发布：push master 自动构建多架构（amd64/arm64）镜像到 GHCR（`ghcr.io/icebear0828/codex-proxy`），docker-compose.yml 切换为预构建镜像，支持 Watchtower 自动更新
- 双窗口配额显示：Dashboard 账号卡片同时展示主窗口（小时限制）和次窗口（周限制）的用量百分比、进度条和重置时间，后端 `secondary_window` 不再被忽略
- 更新弹窗 + 自动重启：点击"有可用更新"弹出 Modal 显示 changelog，一键更新后服务器自动重启、前端自动刷新，零人工干预（git 模式 spawn 新进程、Docker/Electron 显示对应操作指引）
- Model-aware 多计划账号路由：不同 plan（free/plus/business）的账号自动路由到各自支持的模型，business 账号可继续使用 gpt-5.4 等高端模型 (#57)
- Structured Outputs 支持：`/v1/chat/completions` 支持 `response_format`（`json_object` / `json_schema`），Gemini 端点支持 `responseMimeType` + `responseSchema`，自动翻译为 Codex Responses API 的 `text.format`；`/v1/responses` 直通 `text` 字段

- 模型列表自动同步：后端动态 fetch 成功后自动回写 `config/models.yaml`，静态配置不再滞后；前端每 60s 轮询模型列表，新模型无需刷新页面即可选择
- Tuple Schema 支持：`prefixItems`（JSON Schema 2020-12 tuple）自动转换为等价 object schema 发给上游，响应侧还原为数组；OpenAI / Gemini / Responses 三端点统一支持
- WebSocket 传输 + `previous_response_id` 多轮支持：`/v1/responses` 端点自动通过 WebSocket 连接上游，服务端持久化 response，客户端可通过 `previous_response_id` 引用前轮对话实现增量多轮；WebSocket 失败自动降级回 HTTP SSE (#83)
- 账号批量导入导出：Dashboard 支持导出全部账号到 JSON 文件（含 token，用于备份/迁移），支持从 JSON 文件批量导入账号，自动去重 (#82)

### Fixed

- 前端缓存问题：`index.html` 设置 `Cache-Control: no-cache` 防止浏览器缓存旧页面，`/assets/*` 设置 immutable 长缓存（Vite content hash）

### Changed

- Light mode 背景色从 `#f6f8f6` 改为纯白 `#ffffff`，增大亮/暗主题视觉差异
- 提取管道强化：`extract-fingerprint.ts` 新增 fallback 扫描（`.vite/build/*.js` 全文件回退）和 webview 模型发现（`webview/assets/*.js`），pattern 失败不再中断整个流程
- 模型/别名自动添加降级为 semi-auto：后端已通过 `isCodexCompatibleId()` 自动合并新模型，`apply-update.ts` 不再自动写入 `models.yaml`（避免 `mutateYaml` 破坏 YAML 格式）
- Codex Desktop 版本更新至 v26.309.31024 (build 962)

### Fixed

- 自动更新重启可靠性：移除 `.restart-helper.cjs` 临时脚本方案，改为直接 spawn 新进程 + 复用 `index.ts` 内置 EADDRINUSE 重试（10 次 × 1s）；新增 nodeExe 存在性校验防止无声死亡，子进程输出写入 `.restart.log` 便于排查启动失败

### Fixed (pipeline)

- Prompt 提取括号定位修复：`extractPrompts()` 的 `lastIndexOf("[")` 无限回溯导致匹配到无关 `[`，截取错误代码片段产出乱码；改为 50 字符窗口内搜索
- Prompt 覆写安全校验：`savePrompt()` 和 `applyAutoChanges()` 新增内容验证（最小长度 50 字符、乱码行数 ≤3），拒绝将损坏数据写入 `config/prompts/`
- `title-generation.md` 修复：还原因提取 bug 损坏的 title 生成 prompt（第 17-35 行乱码）

### Changed (previous)

- 模型目录大幅更新：后端移除 free 账号的 `gpt-5.4`、`gpt-5.3-codex` 全系列（plus 及以上仍可用），新旗舰模型为 `gpt-5.2-codex`（`codex` 别名指向此模型）
- 新增模型：`gpt-5.2`、`gpt-5.1-codex`、`gpt-5.1`、`gpt-5-codex`、`gpt-5`、`gpt-oss-120b`、`gpt-oss-20b`、`gpt-5-codex-mini`
- 模型目录从 23 个静态模型精简为 11 个（匹配后端实际返回）

### Fixed

- 429 真实冷却时间：从 429 错误响应体解析 `resets_in_seconds` / `resets_at`，账号按后端实际冷却期（如 free 计划 5.5 天）标记限速，不再使用硬编码 60s 默认值 (#65)
- 429 自动降级：收到 429 后自动尝试下一个可用账号，所有账号耗尽后才返回 429 给客户端 (#65)
- 调度优先级优化：`least_used` 策略新增 `window_reset_at` 二级排序，配额窗口更早重置的账号优先使用 (#65)
- JSON Schema `additionalProperties` 递归注入：`injectAdditionalProperties()` 递归注入 `additionalProperties: false` 到 JSON Schema 所有 object 节点，覆盖 `properties`、`patternProperties`、`$defs`/`definitions`、`items`、`prefixItems`、组合器（`oneOf`/`anyOf`/`allOf`）、条件（`if`/`then`/`else`），含循环检测；三个端点（OpenAI/Gemini/Responses passthrough）统一调用 (#64)
- CONNECT tunnel header 解析：循环跳过中间 header block（CONNECT 200、100 Continue），修复代理模式下 tunnel 的 `HTTP/1.1 200` 被当作真实状态码导致上游 4xx 错误被掩盖为 502 的问题 (#64)
- 上游 HTTP 状态码透传：非流式 collect 路径从错误消息提取真实 HTTP 状态码，不再硬编码 502；提取 `toErrorStatus()` 辅助函数统一 4 处 StatusCode 转换 (#64)
- Dashboard 中英文切换按钮宽度跳变：`StableText` 的 `reference` 从英文硬编码改为 `t()` 动态取值，按钮宽度跟随当前语言自适应
- Dashboard "指纹更新中..." 按钮竖排显示：更新状态按钮添加 `whitespace-nowrap`，防止 CJK 字符逐字换行
- CI 版本跳号（v1.0.28 → v1.0.30）：`sync-electron.yml` 的 `cancel-in-progress` 改为 `false`，避免 workflow 被取消后 tag 已推送但版本号未同步回 master；合并两次 `git push` 为一次减少部分推送窗口
- 混合 plan 账号路由失败：free 和 team/plus 账号混用时，请求 plan 受限模型（如 `gpt-5.4`）可能 fallback 到不兼容的 free 账号导致 400 错误，现在严格按 plan 过滤，无匹配账号时返回明确错误而非降级 (#54)
- `cached_tokens` / `reasoning_tokens` 透传：从 Codex API 响应的 `input_tokens_details` 和 `output_tokens_details` 中提取，传递到 OpenAI（`prompt_tokens_details`）、Anthropic（`cache_read_input_tokens`）、Gemini（`cachedContentTokenCount`）三种格式，覆盖流式和非流式模式 (#55, #58)
- Dashboard 模型选择器使用后端 catalog 的 `isDefault` 字段，替代硬编码 `gpt-5.4`
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
