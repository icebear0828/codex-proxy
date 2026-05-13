# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

> **置顶声明**：本项目由个人独立开发维护，自愿开源。该有的功能会加，有 bug 会第一时间修。觉得代码垃圾可以不用，觉得你写得好欢迎提 PR。我没有义务为任何人定制服务。

## [Unreleased]

### Added

- Stream-close 事件结构化落盘到 Errors tab + 审计 log：`premature stream close` / `stream-client-abort` / `stream-client-disconnect` / `stream-error` 此前只走 `console.warn` 进 `dev-YYYY-MM-DD.log`，需要 grep 才能定位，且生产模式没有 tee；新增 `src/logs/stream-close-event.ts` 把这些事件同时写到 `data/error-log.jsonl`（Errors tab 按签名分组 + 角标计数）和 `logStore`（`/admin/logs` 审计流）。覆盖 7 个调用点：`proxy-handler.ts` 两处 client abort + 一处 `UpstreamPrematureCloseError`（带 eventCount / hadReasoning / responseId / variantHash）、`response-processor.ts` 两处（`client-write-failed` 带 writtenChunks/Bytes/lastSentEvent；`upstream-error` 带 upstreamStatus）、`responses.ts` 两处 `streamPassthrough` 内部 EOF（rid / accountEntryId / variantHash 通过 `FormatAdapter.streamTranslator` 的 `streamContext` option 由 `response-processor` 透传，其它 adapter 兼容性接收并忽略）。顺手修 `error-log.ts:readAppVersion` 在 config 未加载时崩溃（unit-test 路径会撞到），改为 try/catch 兜底回退 "unknown"。新增 `tests/unit/logs/stream-close-event.test.ts` 6 个单测覆盖 4 种 kind + 缺失 rid 兜底 + numeric upstreamStatus → audit status 透传 + direct upstream provider/path；Errors tab 展开分组时会显示 sample context。下次复现 premature close 直接看 Errors tab 按 `StreamUpstreamPrematureClose` 分组拉 rid + account + closeCode，不用再 grep dev 日志（`src/logs/stream-close-event.ts`、`src/logs/error-log.ts`、`src/routes/shared/proxy-handler.ts`、`src/routes/shared/response-processor.ts`、`src/routes/responses.ts`、`tests/unit/logs/stream-close-event.test.ts`）
- Opt-in 上游请求/响应 dumper：新增 `src/utils/debug-dump.ts`，环境变量 `CODEX_PROXY_DEBUG_DUMP=1` 启用时把每次上游请求 + 流式 chunk + 终止状态 + 错误写入 `/tmp/codex-proxy-dump-<startupMs>.jsonl`（一行一事件）；未启用时所有 hook 是 `if (debugDumpEnabled())` 守护下的纯 boolean check，零开销。在 `src/routes/shared/proxy-handler.ts` 加 1 个 hook（`request`，含 rid/tag/entryId/conv/implicitResumeActive/resumeReason/payload），在 `src/routes/shared/response-processor.ts` 加 3 个 hook（`upstream-chunk` 截断到 16KB、`stream-finish` 含 chunks/bytes/sawTerminal、`stream-error` 含 status/msg/body 截断到 4KB）。**privacy 警告**：dump 文件包含完整 request payload（含用户 prompt）和上游响应，路径在启动时打印一次提示 sensitive 性质。日常排查"账号轮换重试风暴" / "premature stream close" 等偶发错误时 opt-in 启用，问题复现后再 opt-out
- Pre-publish artifact smoke 拦在 stable 之前（#479）：`release.yml` 把 4 个平台（mac arm64 / mac x64 / win / linux）的 Pack step 从 `--publish always` 改成 `--publish never`，新增跨平台 smoke step 用 `.github/scripts/electron-smoke.sh` 启动打包好的 binary、tail 日志拿 `Server started on port N`、curl `/health`、清进程；smoke 失败直接阻塞 `gh release upload`，artifact 不会进 GitHub Release（坏的就不发）。Linux 装 `libfuse2 + xvfb` 起虚拟显示，Windows 用 `win-unpacked/*.exe` 跳过 NSIS 安装；smoke 失败时通过 `actions/upload-artifact@v4` 把日志保留 7 天给排查。新增 `tests/unit/ci/electron-smoke-script.test.ts` 6 个单测，覆盖脚本的 fail-loud 路径（缺 RUNNER_OS / RELEASE_DIR / AppImage / 不支持的 OS），保证脚本本身坏掉时不会沉默通过。CI 时间增量约 +5 分钟（Linux 最快，Windows 需研究 GHA windows-latest 的 GUI 启动行为，首次 PR 可能要回炉）（`.github/scripts/electron-smoke.sh`、`.github/workflows/release.yml`、`tests/unit/ci/electron-smoke-script.test.ts`）
- Dashboard Errors tab + Header 浮起 badge + 渲染进程错误捕获（observability，#480 PR-2）：新增 `Errors` tab（按 `name + first stack frame` 聚合，按 last_seen 降序，可展开看 sample stack；折叠后只显示一行）；Header 右侧多一个红色 pulsing badge 显示未读错误数（>99 显示 `99+`），点击跳 `#/errors`；渲染进程注册 `window.addEventListener('error')` + `unhandledrejection` 在 `main.tsx` `render()` 之前，每条事件 fetch POST `/admin/error-logs/report`（不走 IPC，复用同源 dashboardAuth）；`useErrorLogs` / `useErrorLogsCount` hook 30s 轮询；i18n 中英双语；`mark all read` 按钮调 `/admin/error-logs/seen` 推进 cursor；新增前端 web bundle +8KB gzipped（`web/src/error-capture.ts`、`web/src/pages/ErrorsPage.tsx`、`shared/hooks/use-error-logs.ts`、`web/src/App.tsx`、`web/src/components/Header.tsx`、`web/src/main.tsx`、`shared/i18n/translations.ts`、`tests/unit/web/error-capture.test.ts`、`shared/hooks/use-error-logs.test.ts`）
- 本地 uncaught error log（observability foundation，#480 PR-1）：进程级 `uncaughtException` / `unhandledRejection` 自动落盘到 `data/error-log.jsonl`，单 backup 滚动（默认 10MB → `error-log.1.jsonl`），`context` 经 `redactJson` 脱敏 token / cookie / api_key / oauth；新增 4 个 admin 端点 `/admin/error-logs`（按 `name + first stack frame` 聚合）/ `/admin/error-logs/raw`（裸 JSONL tail）/ `/admin/error-logs/count`（含 unread）/ `/admin/error-logs/seen`（推进读游标）/ `/admin/error-logs/report`（renderer / 外部 POST 上报）；`uncaughtException` 走 `setImmediate(throw)` 保留 Node 默认崩溃语义，不会静默吞掉 fatal；新增 schema 节 `observability: { local_error_log: bool=true, max_log_bytes: int=10485760 }`；前端 Errors tab + 浮起 badge 由 PR-2 跟进（`src/logs/error-log.ts`、`src/routes/admin/error-logs.ts`、`src/config-schema.ts`、`src/index.ts`、`tests/unit/logs/error-log.test.ts`、`tests/unit/routes/admin/error-logs.test.ts`）

### Fixed

- Update build scripts and their extraction pattern config are tracked again so `npm run update` and the update path regression test do not fail from missing `scripts/build/{check-update,apply-update,full-update,types}.ts` or `config/extraction-patterns.yaml` files in clean checkouts.
- `/v1/chat/completions` now accepts Cursor Agent / Responses-style compatibility payloads before validation: `input` is normalized into chat `messages`, flat function tools and named `custom` tools are converted to OpenAI function tools, and nested `reasoning.effort` maps to `reasoning_effort`. This prevents Cursor Agent provider mode from failing with `messages: Required` or `tools[].function: Required` before the proxy can translate the request (`src/types/openai.ts`, `tests/unit/types/openai-schemas.test.ts`, `tests/e2e/chat.test.ts`)
- `accounts.json` 读取失败时再也不会把空账号池写回磁盘：`loadPersisted`（`src/auth/account-persistence.ts`）此前对 `readFileSync` / `JSON.parse` / `Array.isArray` 三种失败一律 `console.warn` + 返回 `{ entries: [], needsPersist: false }`，registry 用空 Map 起步后任意一次 mutation（refresh-scheduler tick、dashboard 操作、release()）就让 1s debounce 的 `schedulePersist` 把 `{ "accounts": [] }` 原子覆盖到正本——一次读盘抖动（杀软扫描锁定文件、NSIS 升级强杀进程的 `renameSync` race、AV 干扰）就够静默删库，Windows 用户从 2.0.72 升 2.0.73 时已经踩到。修复成三段：(1) `quarantineCorruptFile` 把不可解析的 `accounts.json` 重命名成 `accounts.json.corrupt-<ISO>.bak` 保留原始字节给 debug，并 `appendErrorLog({ source: "server", name: "AccountsFileLoadFailed", context: { reason, accountsFile, quarantined, backupPath, rawByteLength } })` 让 Errors tab 弹红色 badge——`loadPersisted` 把 JSON 先解成 `unknown` 再校验非空对象，覆盖 `null` / 数字 / 顶层数组 这些会让 `data.accounts` 直接抛的 payload；`createFsPersistence` 同时持一个 `quarantineActive` 闩，即便有 caller 跳过 registry 拿到 persistence 直接调 `save()` 也会被拒绝写盘，是 registry 持久化开关的二道防线。`src/logs/error-log.ts` 的 `readAppVersion` 也补上 `getConfig` 抛错的 try/catch，避免 quarantine 在 `loadConfig()` 之前触发时整条 `appendErrorLog` 被外层吞掉、事件从 `error-log.jsonl` 消失；(2) `AccountPersistence.load()` 返回新增 `loadFailed?: boolean` 与 `health?: { quarantined, backupPath }`，`AccountPool` 透传给 `new AccountRegistry(..., { persistDisabled: true })`，`schedulePersist` / `persistNow` 在 disabled 状态下提前 return，本会话内 in-memory CRUD 照常工作但 disk 不再被任意覆盖；(3) `GET /auth/accounts` 响应新增 `persistence_health: { ok, reason, message, quarantined, backupPath }` 字段，rename 成功走 `load_failed_quarantined` 提示用户从 `.bak` 恢复，rename 失败（杀软长锁 / 权限不足）走 `load_failed_unquarantined`，提示中不再承诺一个不存在的 `.bak`。`useAccounts` hook 拉出来后 `AccountManagement` 页面顶部渲染琥珀色 "Auto-save paused" 横幅指引恢复路径。文件缺失（首次启动）不算失败，`loadFailed=false`。配套测试：`tests/unit/auth/account-persistence-load-failsafe.test.ts` 10 个覆盖 malformed JSON / 0-byte / 错误 shape / 缺失文件 / 健康文件 / 时间戳避免冲突 / 顶层 `null` / 顶层非对象 / `save()` 在 quarantine 后短路 / `health.quarantined+backupPath` 透传；`tests/unit/auth/account-registry-persist-disabled.test.ts` 6 个覆盖 schedulePersist no-op / addAccount 仍在内存生效 / pool.isPersistDisabled() 透传 / 健康路径回归；`tests/unit/routes/accounts-persistence-health.test.ts` 4 个覆盖路由响应字段（健康 / 隔离成功 / 隔离失败 message 不带 .bak / 旧 persistence 实现未带 health 时回退到 quarantined reason）；`tests/unit/logs/error-log.test.ts` 加 1 个用例确认 `getConfig` 抛错时 `version: "unknown"` 也能完成写盘。i18n 中英文新增 `persistDisabledTitle` / `persistDisabledBody`（`src/auth/account-persistence.ts`、`src/auth/account-registry.ts`、`src/auth/account-pool.ts`、`src/routes/accounts.ts`、`src/logs/error-log.ts`、`shared/hooks/use-accounts.ts`、`web/src/pages/AccountManagement.tsx`、`shared/i18n/translations.ts`）
- Dashboard 主题 token 改为 contrast-safe 语义色：把 `primary` 文本/选中色与 `primary-action` 实心按钮色拆开，补齐 success/warning/danger/info 与 avatar 的 foreground/container token，统一账号、代理、日志、错误、设置页的按钮和状态 chip 用法；`TabBar` 在移动端允许换行，避免账号管理页窄屏横向溢出；`AccountList` 改读 `window.localStorage`，规避 Node/Vitest 全局 localStorage 与 jsdom 冲突。新增 `DESIGN.md` 自包含设计系统文档与主题 contrast 回归测试（`DESIGN.md`、`web/src/index.css`、`web/tailwind.config.ts`、`web/src/App.tsx`、`web/src/components/AccountList.tsx`、`tests/unit/web/theme.test.ts`、`web/src/App.test.tsx`、`web/src/components/AccountList.test.tsx`）
- Logs 页面窄屏布局改为移动端纵向堆叠，日志表格保留内部横向滚动，不再让整页在 390px viewport 下产生页面级横向溢出；补 `LogsPage` 回归测试锁住表格滚动容器与详情面板响应式宽度（`web/src/pages/LogsPage.tsx`、`web/src/pages/__tests__/logs.test.tsx`）
- 账号"已限速"状态与上游 cachedQuota 双真理漂移彻底修复（free 用户尤甚，本地锁可长达一周不释放）：proxy 此前同时维护 `entry.usage.rate_limit_until` + `entry.status === "rate_limited"`（来自 429 retry-after 的本地锁）和 `entry.cachedQuota.<bucket>.limit_reached/reset_at`（来自上游 rate_limits header 被动收集）两套独立信号。`refresh-scheduler.ts:196/236/291` 和 `services/account-mutation.ts:59` 的 `markStatus(_, "active")` 调用会把 status 从 "rate_limited" 翻回 "active" 但不动 `rate_limit_until`，导致后者成为孤儿字段——dashboard 显示"已限速 / 5h 0% 已使用"自相矛盾，且对 free 账号"7d 主窗口"语义下，孤儿 lock 可比上游真实重置时间晚出整整一个周期。修复：(1) 删除 `markRateLimited` / `clearRateLimit` / `markQuotaExhausted` 三个旧方法，新增 `applyRateLimit429(entryId, { retryAfterSec?, resetsAtSec?, countRequest? })`，把 429 retry-after 直接写到 `cachedQuota.rate_limit.{limit_reached=true, reset_at}`，永不缩短已有 reset_at（下一次 passive header 采集会修正 bucket），不再 mutate `entry.status`；(2) `AccountStatus` 枚举去掉 `"rate_limited"`（只剩 `active / expired / quota_exhausted / refreshing / disabled / banned`，纯轮转状态机）；(3) 重写 `proxy-error-handler.ts:91` / `proxy-handler.ts:545` 走新方法；(4) `refreshStatus` 删掉 rate-limit 清理分支（`resetExpiredQuotaWindow` 已 cover 窗口到期自动清 `limit_reached`）；(5) `isAuthenticated` / `getPoolSummary` 加 `hasReachedCachedQuota` 检查，避免全 quota 耗尽时误报 authenticated；(6) `accounts.json` 一次性 migration：`migrateLegacyRateLimit` 在 `loadPersisted` 里把 `status="rate_limited" + rate_limit_until` 老条目转成 `status="active" + 合成 cachedQuota.rate_limit`（仅当本地 lock 比 cachedQuota 新鲜时才覆盖），下一次 persist 自动丢字段；(7) `web/src/lib/accountStatus.ts` 新增 `derivedStatus(account)`，dashboard `AccountCard` / `AccountList` 都按 cachedQuota → "rate_limited" 派生 badge，"已达上限"账号现在如实显示而不是错标"活跃"；新增 `tests/unit/auth/account-pool-rate-limit-429.test.ts`（9 个）+ `tests/unit/auth/account-persistence-migration.test.ts`（7 个），改写约 20 处旧 `markRateLimited` / `markQuotaExhausted` 断言用 `applyRateLimit429` + `isQuotaExhausted(account.quota)`，full suite 1927 全绿（`src/auth/account-registry.ts`、`src/auth/account-pool.ts`、`src/auth/account-persistence.ts`、`src/auth/types.ts`、`src/auth/quota-skip.ts`、`src/routes/shared/proxy-error-handler.ts`、`src/routes/shared/proxy-handler.ts`、`web/src/lib/accountStatus.ts`、`web/src/components/AccountCard.tsx`、`web/src/components/AccountTable.tsx`、`web/src/components/AccountList.tsx`、`web/src/pages/AccountManagement.tsx`）
- `src/routes/shared/proxy-handler.ts` 对 `EmptyResponseError` 与"上游 reasoning 中途断流"两类错误未区分，前者会 cross-account retry（吃 3 个号），后者重试也一定会再次撞同样的上游 120s 硬上限——一次"上游 reasoning 没在 ~120s 内 emit 任何 output_text"会消耗整池 360s 的号。新增 `UpstreamPrematureCloseError`（`src/translation/codex-event-extractor.ts`），`collectCodexResponse`（`src/translation/codex-to-openai.ts`）检测到 stream 无 `response.completed`/`response.failed`/`error` 任一 terminal 事件时抛新类型，proxy-handler 接住直接 504 fail-fast 不跨号重试。背景：调查中观察到上游 chatgpt.com 在 HTTP/1.1 chunked encoding 的 chunk 之间硬切 TCP，不发 0-length 终止 chunk 也不发 SSE `[DONE]`（hyper 透出 `error decoding response body: unexpected EOF during chunk size line`），触发条件为模型在 `effort=xhigh` 下推理超过 ~120s 仍未开始 output——属于上游 backend 行为不是 proxy bug；proxy 现在做的是不让该故障吃光账号池（`src/translation/codex-event-extractor.ts`、`src/translation/codex-to-openai.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/translation/codex-to-openai.test.ts`、`tests/integration/proxy-handler.test.ts`）
- `src/utils/debug-dump.ts` 把 dump 文件路径硬编码 `/tmp/codex-proxy-dump-*.jsonl`，Windows 没有 `/tmp` 目录，`fs.appendFileSync` ENOENT 直接被外层 try/catch 吞掉——Windows 用户即使设了 `CODEX_PROXY_DEBUG_DUMP=1` 也拿不到任何 dump 输出，且没有任何 warning。改用 `os.tmpdir()` 解析（macOS `/var/folders/.../T`、Linux `/tmp`、Windows `C:\Users\<u>\AppData\Local\Temp`），跨平台一致。新增 `tests/unit/utils/debug-dump.test.ts` 把"dump path must live under os.tmpdir()"freeze 成显式断言，防止以后再有人为了"看着短"重新硬编码 `/tmp`
- v2.0.73 用户在 8080 端口被占时弹 `Uncaught Exception: Error: listen EADDRINUSE: address already in use 127.0.0.1:8080`：根因是 `@hono/node-server.serve()` 同步返回 Server 对象但 `listen()` 是异步，`startServer()` 在 socket 真正 bind 之前就 resolve 了，main.ts 那个`try { await startServer(...) } catch { startServer({ port: 0 }) }` 的随机端口 fallback 永远不触发——EADDRINUSE 在 `await` 之外异步抛，逃出 catch 范围变成 uncaughtException 弹给 Electron 用户。同一个 race 在 #486 smoke 健康探测里以另一种形态出现过（grep 命中 "Server started" 后 curl 立刻 connect refused），当时只在外层 retry 上吸收了，没动产品代码；这次把根因修在 src 层。新增 `src/utils/await-listening.ts` 暴露 `awaitServerListening(server)`，监听 `listening` / `error` 二选一并自清 listener；`startServer()` 在 `serve()` 后插一行 `await awaitServerListening(server)` 把 bind 错误真正变成 startServer 的拒绝。配套 `tests/unit/utils/await-listening.test.ts` 5 个单测覆盖 listening / error / 已 listening / 双向不泄漏 listener。修复后 main.ts 的随机端口 fallback 真正生效，8080 被占时会自动换一个端口（`src/utils/await-listening.ts`、`src/index.ts`、`tests/unit/utils/await-listening.test.ts`）
- Electron auto-updater 真正尊重 `autoUpdate` 选项：`packages/electron/electron/auto-updater.ts` 里 `const isAutoUpdate = options.autoUpdate ?? true` 这个变量声明了但**从来没被使用过**——后续的 `setTimeout(initial check, 30s)` 与 `setInterval(periodic check, 4h)` 直接无条件运行，于是用户即便配了 `autoUpdate: false` 也照样后台 ping 上游 latest release 检查更新。把这两个定时器包到 `if (isAutoUpdate)` 内才让开关真的生效。补 `packages/electron/__tests__/auto-updater.test.ts` 两个 case：(1) `autoUpdate: false` 时 advance fake timer 不会触发任何 `checkForUpdates`；(2) `allowPrerelease: true` 真的写到 `mockAutoUpdater.allowPrerelease`
- 清掉 web 前端几处 type 与 prop 不一致：(1) `web/src/App.tsx` 给 `<AccountList>` 传了 `onAddByRefreshToken={accounts.addByRefreshToken}`，但 `AccountList.tsx` 根本没接受这个 prop —— dead prop，删掉避免误导未来读者；(2) `web/src/components/SettingsTab.tsx` 的 `modelFamilies` prop 标成 `Record<string, string[]>`，但调用方传入的是 `useStatus()` 返回的 `ModelFamily[]`（`shared/hooks/use-status.ts:11` 已 export 该接口），prop 类型与实参不一致——改为 `ModelFamily[]`；同时把 `selectedSpeed` / `onSpeedChange` 拓宽到 `string | null` 与实际语义对齐；(3) `shared/hooks/use-accounts.ts` 的导入解析里 `parsed.accounts` 直接访问 unknown 字段，在 strict 模式下不安全，先窄化成 `Record<string, unknown>` 再读 `accounts`，避免 runtime 拿到非对象 JSON 时炸；(4) `web/src/components/AccountList.test.tsx` 第 111 行 `[...makeAccounts(12, "active"), makeAccounts(2, "expired")]` 漏了 spread —— 把第二组 helper 的返回值（数组）当成单个元素塞进列表，直接破坏断言前提。改成 `...makeAccounts(2, ...)`（`web/src/App.tsx`、`web/src/components/SettingsTab.tsx`、`web/src/components/AccountList.test.tsx`、`shared/hooks/use-accounts.ts`）
- `scripts/build/extract-fingerprint.ts` 的 `ROOT` 解析比 sibling 脚本（`apply-update.ts` / `check-update.ts` / `full-update.ts`）少一层 `..`，原写法是 `resolve(import.meta.dirname, "..")`，得到的是 `scripts/` 而不是 repo root，导致后续 `data/extracted-fingerprint.json`、`data/extracted-prompts/`、`config/extraction-patterns.yaml` 这些路径全部锚错位置——脚本表面上能跑，但读写的全是 `scripts/data/...` 这种"幽灵目录"，真实 repo 根下的 `data/` 拿不到任何更新。改为 `resolve(import.meta.dirname, "..", "..")` 与 sibling 一致；新增 `tests/unit/update-scripts-path.test.ts` 把"`scripts/build/*` 必须用 `..,..` 解析 ROOT"这条隐式约定 freeze 成显式断言，防止以后再有人复制粘贴漏一层
- Electron 端 WS transport 触发时抛 `Dynamic require of "events" is not supported`：`packages/electron/electron/build.mjs` 把 backend bundle 成 ESM `server.mjs` 时 esbuild 把 CJS `ws` 整个打进来，包内 `require("events")` / `require("https")` 等被改写成内部 `__require` shim；ESM 模块里 `require` 是 undefined，shim 走「typeof require === undefined」分支直接 throw。WS path 只有 `previous_response_id` 才走，#468 拆分 sub-agent prev_id 链后 WS 触发频率上来才暴露这个一直存在的 bundling bug。修复：build.mjs 给 ESM build 加 `banner.js` 注入 `import { createRequire } from "module"; const require = createRequire(import.meta.url);`，让 `__require` 命中真 `require` 路径，Node builtins 正常解析；新增 `packages/electron/__tests__/build.test.ts` 中 banner 回归断言（`packages/electron/electron/build.mjs`、`packages/electron/__tests__/build.test.ts`、`src/proxy/ws-transport.ts` 注释订正）
- Anthropic（Claude Code）路径 cache 命中率长期被 sub-agent / 并行 tool call 拖低：根因是同一个 `x-claude-code-session-id` 下不同 system + tools 的请求共享同一个 WS pool slot 与 prev_response_id 链，sub-agent 抢不到 pool 里的 WS（`per-WS strict serial`）→ `ws=bypass(busy)` → 新 WS 被上游 LB hash 到不同后端实例 → `previous_response_not_found` → strip-and-retry → 全冷重发，sub-agent 每一轮都是冷启动。修复：(1) 新增 `src/routes/shared/variant-hash.ts`，用 `sha256(instructions + JSON.stringify(tools)).slice(0,12)` 算 12 字符 variantHash 作为请求"形状指纹"；(2) WS pool key 从 `entryId:convId` 扩成 `entryId:convId:variantHash`，同 conv 内不同 variant 各自独占 WS / 后端实例，互不挤占；(3) `SessionAffinityMap.record` / `lookupLatestResponseIdByConversationId` 增加可选 `variantHash` 维度（不传保持原行为，兼容 `[Responses]` / `[Chat]` / `[Gemini]` 路径），让 sub-agent 续到自己的 prev id 链而不是误读主对话的；(4) implicit-resume 查 affinity 时同时传 `IMPLICIT_RESUME_MAX_AGE_MS = 55 * 60 * 1000`（贴 `ws-pool` 自身 55min `max_age_ms` 上限），超过这个时间窗的 prev id 直接当 null，避免发已被上游驱逐的 id 触发必败 round-trip。客户端可见的 `prompt_cache_key` 不变，variantHash 只在 proxy 内部用于隔离。实测 36 个 Claude Code 请求覆盖 4 个 variant：`previous_response_not_found` 从一日 35 次 → 0、`ws=bypass(busy/factory_error)` 从一日 76 次 → 0、命中率 < 50% 的请求占比从 7% → 0%（`src/routes/shared/proxy-handler.ts`、`src/auth/session-affinity.ts`、`src/routes/shared/variant-hash.ts`、`tests/unit/routes/shared/variant-hash.test.ts`、`tests/unit/auth/session-affinity.test.ts`、`tests/unit/routes/implicit-resume-from-derived-key.test.ts`）
- 同一 session 下多个 subagent / 并行 agent 的隐式续链隔离再加固：`variantHash` 现在纳入本地-only `variantIdentity`（`x-codex-window-id`，以及显式 session / `prompt_cache_key` 场景下的首条 user anchor），保证上游 `prompt_cache_key` 仍共享同一缓存键，但 proxy 本地 `previous_response_id` 链和 WS pool slot 不会把同形 subagent 串到一起。补回归测试覆盖单对话多轮、多个对话交错、无显式 session、同 session 同 system/tools 不同任务，以及“请求内容完全相同、仅 Codex window id 不同”的 subagent 隔离（`src/routes/shared/proxy-handler.ts`、`src/routes/shared/variant-hash.ts`、`tests/unit/routes/implicit-resume-from-derived-key.test.ts`、`tests/unit/routes/shared/variant-hash.test.ts`）
- `/v1/responses` streaming 提前断流时不再让客户端只看到裸 EOF：HTTP/WS passthrough 现在追踪 `response.completed` / `response.failed` / `error` 终止事件；上游在终止事件前结束或 WebSocket 首帧后中断时，会合成 `response.failed`（`code=stream_disconnected`）或让上层转换为该失败事件，避免 Codex CLI 报 `stream disconnected before completion: stream closed before response.completed` 且没有结构化错误
- 恢复模型名 `-fast` 后缀的上游出口语义：`gpt-5.4-high-fast` / `codex-fast` 仍先解析为标准模型名 + `service_tier=fast`，最终发往 Codex backend 时再映射成官方接受的 `service_tier="priority"`（HTTP SSE 与 WebSocket 路径一致）；补回单测和 `/v1/responses` E2E，防止 PR #453 的 review quota plumbing 再次把 `service_tier` 丢掉
- Dashboard 更新状态兼容旧响应：`/admin/update-status` 尚未返回 `settings` 字段时，前端默认按 `show_update_dialog=false` 处理，避免读取 `settings.show_update_dialog` 抛错导致页面白屏
- Official Codex app-server bridge 审计加固：首批并发请求现在复用同一个 WebSocket 连接与 `initialize` 流程，避免 CONNECTING 阶段重复建连/覆盖 `this.ws`；并发 turn SSE 改为串行执行，避免共享 notification queue 把 A/B 两个 turn 的 delta/completed 交叉发错；`/official-agent/*` 改用独立 `official_agent.api_key`，不再复用通用 `server.proxy_api_key`，并限制 `approvalPolicy` 只能是 `untrusted` / `on-request` / `on-failure` / `never`
- 隐式续链反向校验缺失导致客户端持续看到上游 `invalid_request_error: No tool output found for function call call_X`：`evaluateImplicitResume` 此前只做 forward 检查（新输入里的 `function_call_output.call_id` 必须命中上一轮 stored function_call），漏了反向（上一轮 stored function_call 必须在新输入里有 output）。当上一轮模型并发吐 N 个 tool_use、客户端只回 N-1 个 tool_result 时，proxy 仍然 resume + `previous_response_id` 发出去，上游存的 context 里那个未回复的 function_call 触发 400。新增反向检查 → 走完整重放（`reason: "unanswered_tool_calls"`），同时 `error-classification.ts` 加 `isUnansweredFunctionCallError`，proxy-handler catch 块兜底：strip `previous_response_id` + 完整历史重放 + 同账号重试一次（与 `previous_response_not_found` 同款），避免 ws/sse 路径上的 400 静默吞掉变成 502
- `codex-to-anthropic.ts` / `codex-to-openai.ts` / `codex-to-gemini.ts` 非流式 collect 路径里把上游错误事件抛成 `new Error(...)`，丢失 status 信息，handleNonStreaming 的 collectErr 再通过正则匹配 `HTTP/X.X NNN` 状态码必然失败 → 一律 502 兜底，客户端拿到的是模糊的 502 而不是上游真实的 400/429。改为统一 `codexApiErrorFromEvent(evt.error)` 抛 `CodexApiError(status, body)`，按 error code 映射到 400/401/402/403/429（默认 502）；handleNonStreaming 的 collectErr 也加一条 `instanceof CodexApiError` 分支直接透传 status，不再走正则降级
- `streamResponse` 流式路径里上游错误此前只往 SSE 写一条 `stream_error` 事件、零日志，客户端能看到错误但 proxy `dev-YYYY-MM-DD.log` 里完全没记录，排查时无证据链。catch 块加 `console.warn` 打 `status / msg / body`，留下 call_id 等关键现场

### Changed

- `handleProxyRequest` / `handleDirectRequest` 改为 named options object 调用契约，顺带把 private `handleNonStreaming` 的 20 个位置参数收敛成内部 options object，避免后续新增可选上下文时错位；所有 route 调用与直接 handler 测试同步迁移，并补 direct upstream route guard 锁住 adapter/raw model/format tag 传递（`src/routes/shared/proxy-handler.ts`、`src/routes/chat.ts`、`src/routes/messages.ts`、`src/routes/gemini.ts`、`src/routes/responses.ts`、`tests/unit/routes/upstream-auth-bypass.test.ts`）
- `FormatAdapter.streamTranslator` / `collectTranslator` 改为 single options object 契约，替换原先 9 个 / 6 个位置参数，避免 `tupleSchema` / `usageHint` / `onResponseMetadata` / `streamContext` 后续扩展时错位；Chat / Messages / Gemini / Responses adapter wrapper 保持下游 translator 行为不变，并补 streaming、Codex collect、direct collect 三条 guard 测试锁住 options object 传递（`src/routes/shared/proxy-handler.ts`、`src/routes/shared/response-processor.ts`、`src/routes/chat.ts`、`src/routes/messages.ts`、`src/routes/gemini.ts`、`src/routes/responses.ts`、`tests/unit/routes/shared/response-processor.test.ts`、`tests/integration/proxy-handler.test.ts`、`tests/unit/routes/shared/error-forwarding.test.ts`）
- `streamResponse` 改为 named options object 调用契约，替换原先 11 个位置参数，避免 `tupleSchema` / `onResponseId` / `usageHint` / `onResponseMetadata` / `diagnostics` 后续继续错位；Codex streaming 与 direct streaming 两个 caller 同步迁移，并补 caller-level guard 锁住 `streamContext` 的 Codex vs direct provider/path 归因（`src/routes/shared/response-processor.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/response-processor.test.ts`、`tests/integration/proxy-handler.test.ts`、`tests/unit/routes/shared/error-forwarding.test.ts`）
- 非流式 collect/retry 路径从 `proxy-handler.ts` 抽到独立 `non-streaming-handler.ts`，并把 `buildCodexApi`、image generation usage 标记、Codex error prefix 清理收敛到 `proxy-handler-utils.ts`，降低主 handler 对 empty-response retry / premature-close / affinity 逻辑的耦合；新增模块边界测试、collect 阶段 `previous_response_not_found` strip-retry guard、non-stream affinity metadata guard（`src/routes/shared/non-streaming-handler.ts`、`src/routes/shared/proxy-handler-utils.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/non-streaming-handler-boundary.test.ts`、`tests/integration/proxy-handler.test.ts`）
- `proxy-handler.ts` 的共享类型契约抽到独立 `proxy-handler-types.ts`，route / helper / test helper 统一从类型模块导入 `ProxyRequest`、`FormatAdapter`、translator options 与 handler options，避免 `response-processor.ts` / `non-streaming-handler.ts` 为类型依赖反向指向运行时 orchestrator；新增 structural guard 锁住完整契约导出、handler 不再声明共享接口、以及禁止从 `proxy-handler.js` 混入这些共享类型（`src/routes/shared/proxy-handler-types.ts`、`src/routes/shared/proxy-handler.ts`、`src/routes/shared/response-processor.ts`、`src/routes/shared/non-streaming-handler.ts`、`tests/unit/routes/shared/proxy-handler-type-boundary.test.ts`）
- API-key direct upstream 路径从 `proxy-handler.ts` 抽到独立 `direct-request-handler.ts`，route 层直接导入 direct handler，`proxy-handler.ts` 专注账号池 acquire / retry / release 编排；流式错误 SSE helper 抽到 `stream-error-response.ts` 供 Codex proxy 与 direct upstream 共用，并新增 structural guard 防止 `handleDirectRequest` 回流到 `proxy-handler.js`（`src/routes/shared/direct-request-handler.ts`、`src/routes/shared/stream-error-response.ts`、`src/routes/shared/proxy-handler.ts`、`src/routes/chat.ts`、`src/routes/messages.ts`、`src/routes/gemini.ts`、`src/routes/responses.ts`、`tests/unit/routes/shared/direct-request-handler-boundary.test.ts`）
- prompt-cache identity、implicit-resume 判定、continuation input / function-call-output helper 从 `proxy-handler.ts` 抽到独立 `proxy-session-helpers.ts`，让主 handler 只保留编排与状态变更；原 implicit-resume 单测改为直接覆盖 helper 模块，并新增 structural guard 防止这些 session helper 回流到 `proxy-handler.js`（`src/routes/shared/proxy-session-helpers.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-handler-implicit-resume.test.ts`、`tests/unit/routes/shared/proxy-session-helpers-boundary.test.ts`）
- 流式响应生命周期从 `proxy-handler.ts` 抽到独立 `streaming-handler.ts`，集中处理 Hono SSE header / client abort / affinity 记录 / usage 日志 / release guard，让主 handler 的 streaming 分支只负责路由到流式或非流式处理；新增行为测试覆盖 stream usage / response metadata affinity、final abort 与 release-with-usage，并用 AST/import 边界测试防止 `streamResponse`、stream close 记录逻辑回流到 orchestrator（`src/routes/shared/streaming-handler.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/streaming-handler.test.ts`、`tests/unit/routes/shared/streaming-handler-boundary.test.ts`）
- proxy 终端错误响应格式化从 `proxy-handler.ts` 抽到独立 `proxy-error-response.ts`，集中处理 no-account、stream-vs-json error、429 formatter 与账号池耗尽详情拼接，让主 handler catch 分支继续专注错误分类、释放与 fallback 编排；新增行为测试与 AST/import 边界测试防止 `stream-error-response` / `StatusCode` 渲染细节回流到 orchestrator（`src/routes/shared/proxy-error-response.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-error-response.test.ts`、`tests/unit/routes/shared/proxy-error-response-boundary.test.ts`）
- Codex 上游 rate-limit header / WS event 的账号池同步逻辑从 `proxy-handler.ts` 抽到独立 `proxy-rate-limit.ts`，集中处理 `ParsedRateLimit` → cached quota、primary window sync 与 exhausted-primary 的 `applyRateLimit429` side effect；新增行为测试锁住 future reset 才主动限速、无 primary reset 不同步窗口，并用 AST/import 边界测试防止 `rateLimitToQuota` 回流到主 orchestrator（`src/routes/shared/proxy-rate-limit.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-rate-limit.test.ts`、`tests/unit/routes/shared/proxy-rate-limit-boundary.test.ts`）
- 请求间隔 stagger helper 从 `proxy-handler.ts` 抽到独立 `proxy-stagger.ts`，让 Codex passthrough compact route 不再为了复用工具函数反向导入 runtime orchestrator；新增行为测试锁住 disabled/null/elapsed/remaining wait 与 `jitterInt(interval, 0.3)` 语义，并用 AST/import 边界测试防止 `getConfig` / `jitterInt` 回流到主 handler（`src/routes/shared/proxy-stagger.ts`、`src/routes/shared/proxy-handler.ts`、`src/routes/responses.ts`、`tests/unit/routes/shared/proxy-stagger.test.ts`、`tests/unit/routes/shared/proxy-stagger-boundary.test.ts`）
- WebSocket pool context builder 从 `proxy-handler.ts` 抽到独立 `proxy-ws-context.ts`，由主 handler 显式传入已解析的 chain conversation id、variantHash、当前 entryId、requestId 与 route tag，避免 helper 重新推导会话身份或提前创建 pool singleton；新增行为测试锁住 poolKey、延迟 `getWsPool()`、decision 日志标签，并用 AST/import 边界测试防止 `getWsPool` 回流到主 orchestrator（`src/routes/shared/proxy-ws-context.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-ws-context.test.ts`、`tests/unit/routes/shared/proxy-ws-context-boundary.test.ts`）
- 请求诊断日志格式化从 `proxy-handler.ts` 抽到独立 `proxy-request-diagnostics.ts`，集中生成账号/会话/prev/resume/payload summary 与大 payload per-item warning，让主 handler 继续只负责 acquire/retry/release 编排；新增行为测试锁住 explicit/implicit prev、affinity、reasoning、large payload warning，并用 AST/import 边界测试防止诊断字符串拼接回流到 orchestrator（`src/routes/shared/proxy-request-diagnostics.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-request-diagnostics.test.ts`、`tests/unit/routes/shared/proxy-request-diagnostics-boundary.test.ts`）
- opt-in request debug dump 从 `proxy-handler.ts` 抽到独立 `proxy-debug-dump.ts`，把 `debugDumpEnabled()` / `debugDump("request")` wiring 移出 retry loop；新增行为测试锁住 disabled no-op、payload 引用、conversation null 化与 caller-provided resume reason，并用 AST/import 边界测试防止 debug dump utility 回流到主 orchestrator（`src/routes/shared/proxy-debug-dump.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-debug-dump.test.ts`、`tests/unit/routes/shared/proxy-debug-dump-boundary.test.ts`）
- Codex upstream egress audit log 记录从 `proxy-handler.ts` 抽到独立 `proxy-egress-log.ts`，集中维护 `/codex/responses`、provider/status/latency 与 request metadata 字段，让 retry loop 只保留 timing 起点和 helper 调用；新增行为测试锁住 latency、stream/useWebSocket 元数据与 nullable status，并用 AST/import 边界测试防止 `enqueueLogEntry` 回流到主 orchestrator（`src/routes/shared/proxy-egress-log.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-egress-log.test.ts`、`tests/unit/routes/shared/proxy-egress-log-boundary.test.ts`）
- 更新提示默认不再弹窗：新增 `update.show_update_dialog`（默认 `false`），Dashboard 设置页可手动开启“显示更新弹窗”。Web 自更新弹窗与 Electron 自动更新的系统对话框都受该开关控制；更新检查和托盘/菜单入口仍保留，避免默认后台检查打断使用
- `src/routes/api-keys.ts` 简化第三方 API key 绑定路由：合并 add/import 的重复 Zod schema，统一 JSON 解析与校验错误返回，复用按 `models` 展开写入的逻辑，并新增 `tests/unit/routes/api-keys.test.ts` 覆盖添加、导入、导出、custom provider 校验与批量删除，确保行为不变
- README / README_EN 的 Codex CLI + Codex Desktop 两节示例从 `env_key = "PROXY_API_KEY"` 改成 `[model_providers.proxy_codex.http_headers]` 内嵌 `Authorization = "Bearer ..."`：原写法在 GUI 客户端启动时会因为 macOS / Windows GUI 进程不继承 shell rc 的环境变量而报 `Missing environment variable: PROXY_API_KEY`，普通用户得额外学 `launchctl setenv` 或 LaunchAgent 才能让 Codex Desktop 看到环境变量；http_headers 把 key 直接写在 config 文件里，重启 Codex 即用。`env_key` 写法作为「需要密钥从配置文件解耦」（多人共享 / 仓库提交）场景的备选保留在文档说明里

### Fixed

- `promote-dev-to-master.yml` 与 `bump-electron.yml` 末尾各补一步 `gh workflow run docker-publish.yml --ref master`：GitHub Actions 安全策略禁止默认 `GITHUB_TOKEN` 触发的 push 事件再触发其他 workflow（防递归），导致 promote 把 dev fast-forward 到 master、bump 提交版本号 commit + tag 之后，`docker-publish.yml` 的 `on: push: branches: [master]` 全部静默不跑——表象就是 ghcr.io 上的 `:latest` / `:vX.Y.Z` 长期停留在最后一次"人手 push master"的时刻（最近一次是 2026-04-30，期间 master 已经吃下 4 天的 promote）。`workflow_dispatch` 是 GITHUB_TOKEN 允许触发的少数事件之一，所以两条管道收尾各 dispatch 一次即可衔接；docker-publish 已有 `concurrency: cancel-in-progress: true`，promote + bump 两次 dispatch 在窗口期重叠时后者直接接管，最终镜像反映 bump 后的新版本号。配套把 promote 的 `permissions: actions` 从 `read` 升到 `write`（dispatch 需要）

### Added

- Dev 默认把 stdout/stderr tee 到 `logs/dev-YYYY-MM-DD.log`（`src/utils/log-file.ts` + `src/utils/install-dev-logger.ts`，`src/index.ts` 顶部 side-effect 引入）：之前 dev 日志只活在 `tsx watch` terminal 的 scrollback 里，关窗或滚出去就找不到，排查上游偶发 422 之类的错误拿不到证据。新模块按天打开 append fd，patch `process.stdout.write` / `process.stderr.write` 同步写入文件 + 调原函数；prod (`NODE_ENV=production`) / 测试 (`VITEST` / `NODE_ENV=test`) / `CODEX_PROXY_FILE_LOG=0` 三档 opt-out，`logs/` 已被 `*.log` gitignore 覆盖。`tests/unit/utils/log-file.test.ts` 7 个用例覆盖 stdout/stderr tee、目录递归创建、uninstall 还原、append 不截断、默认文件名格式
- Dashboard 用量页新增「时段命中率（Range Hit Rate）」卡片：基于当前选中时间窗口聚合 `cached_tokens / input_tokens`，与原本的全局累计「Cache Hit Rate」卡并列，方便对比近窗口与历史命中率（`web/src/pages/UsageStats.tsx`、`shared/i18n/translations.ts`）
- Dashboard 用量页新增独立的「Hit Rate Over Time」图：每个 bucket 渲染命中率折线 + 数据点 dot，hover 可见 `cached / input`；`input=0` 的 bucket 自动跳过（不渲染 0% 假命中），单数据点也用 dot 保证可见性（`web/src/components/UsageChart.tsx`）
- Usage history `five_min` granularity（5 分钟桶）+ Dashboard 新增「5 min」粒度选项与「Last 1h / 6h」时间窗：snapshot 默认 5 分钟一记，新粒度等同于一桶一快照，方便排查刚发生的请求；旧的 hourly/daily 不变，按 granularity 自动收敛兼容窗口（`src/auth/usage-stats.ts`、`src/routes/admin/usage-stats.ts`、`shared/hooks/use-usage-stats.ts`、`web/src/pages/UsageStats.tsx`）
- 共享纯函数 `formatHitRate` / `sumWindow` / `formatUsageNumber` 抽到 `shared/utils/usage-stats.ts`，配套 vitest 单测覆盖边界（input=0 → "—"、<0.01% 截断、windowed 求和等），UsageChart 与 UsageStats 复用同一份格式化逻辑（`shared/utils/usage-stats.ts`、`shared/utils/__tests__/usage-stats.test.ts`）
- WebSocket 连接池新增 keepalive ping + liveness 检测（`src/proxy/ws-pool.ts`）：每个 `PersistentWs` 默认 25 s 发一次 WS ping 帧（`DEFAULT_PING_INTERVAL_MS`），抵消上游 LB / NAT / 防火墙的 idle timeout 静默 RST；同时跟踪 `lastActivityAt`（pong 或任何 message 都算 proof of life），超过 `livenessTimeoutMs`（默认 = 2.5 × ping interval ≈ 62.5 s）无上游信号则主动 `markDead`，避免下次 acquire 复用一个已经"OPEN 但实际死了"的连接。E2E 验证（设备 a → 本机 8080）：单 WS 撑满 10 轮 + 70 s idle gap，turn 6 跨越 gap 后 hit 仍 99.6%（与 turn 5 持平），0 次 `liveness timeout` 误杀。Busy 时跳 ping（streaming data frame 已 keepalive）。`pingIntervalMs: 0` 或 `livenessTimeoutMs: 0` 各自独立可禁用（`tests/unit/proxy/ws-pool.test.ts` 共 11 个新单测覆盖：ping 节奏 / dead 后停 / readyState 守卫 / busy 跳过 / 错误吞咽 / liveness 误杀 / pong 重置 / message 重置 / 默认值边界等）
- `promote-dev-to-master.yml` 新增 `force_skip_soak` 手动 input（`.github/workflows/promote-dev-to-master.yml`）：原本 soak 检查取的是 dev HEAD 的 commit timestamp ≥ 24 h，正常 merge 节奏下每次新 commit 都会 reset 时钟，导致 master 长期卡死收不到 dev 的更新（实测多个 PR 堵了一周没晋升）。新 input 仅在手动 `workflow_dispatch` 时可用、默认 false（保持原 soak 行为）；schedule cron 走默认 false 不受影响。仅在 sync-back / merge commit "时间新但内容稳定" 的紧急晋升场景使用

### Fixed

- **WebSocket 连接池**（`src/proxy/ws-pool.ts` + `src/proxy/ws-transport.ts` + `src/routes/shared/proxy-handler.ts`）：上游 chatgpt.com 的 WS gateway 按"连接 ID"做负载均衡 hash，过去 codex-proxy 对每个 WS 请求都 `new WebSocket(url)`，导致同一会话同一账号的 prompt cache 命中率在 5%~99% 之间剧烈抖动（同一逻辑会话被路由到不同 backend，每个 backend 各自缓存了不同长度的前缀；实测 cached_tokens 反复出现 1920/2432/24448/40320/47488 等离散"checkpoint"）。引入 per-`(entryId, conversationId)` 的持久 WS 连接池：
  - 单 WS 上 strict request/response 串行（codex 协议要求），busy 时旁路开新一次性 WS 而非排队（避免死锁）
  - 无 idle TTL，连接保持开放直到自然死亡 / `max_age_ms`（默认 55 min，留 5 min 缓冲，比 server 60 min 硬限制提前关）/ 账号状态变化（`evictByEntryId`）级联清理
  - 复用失败（pre-response close）抛 `WsReusedConnectionError`，自动单次 fallback 到一次性新连接；流中段失败保持原语义抛给客户端（不重试，client 已收到部分数据）
  - account-pool 在 `markRateLimited` / `markStatus(non-active)` / `removeAccount` / `updateToken`（refresh 完成）时级联 `evictByEntryId`，避免老 WS 携带的 access_token 被复用
  - 新增配置 `ws_pool: { enabled: true, max_age_ms: 3300000, max_per_account: 8 }`；可 `enabled: false` + 重启回滚到旧行为
  - SIGTERM/SIGINT 进程退出钩子追加 `wsPool.shutdown()` 优雅关闭所有池中连接
  - 入口日志加 `ws=reuse:<id>` / `ws=new:<id>` / `ws=bypass(<reason>)` / `ws=retry-after-stale-reuse:<id>` 字段，配合 `rid` 可对照 cache 命中率
  - 集成测：`tests/integration/ws-pool-reuse.test.ts` 起本地 `ws.Server` 验证 5 turn 同会话只触发 1 次 `connection`

### Changed

- `src/routes/shared/proxy-handler.ts` 入口与 Usage 日志补充诊断字段：入口行新增 `rid` / `conv` / `key` / `prev=<src>:<tail8>` / `tools=N` / `resume=on|off:<reason>`（reason 含 `no_pref_entry`/`acct_mismatch`/`instr_diff`/`missing_tool_calls`/`cont_start_eq_len`），Usage 行带 `rid` 与 `hit=X.X%`，便于对照 prompt-cache 命中率为何偏低、或同一会话请求是否落到同一 cache key
- 上游请求补 `x-codex-installation-id` header 与 body 内 `client_metadata: { "x-codex-installation-id": <uuid> }`（HTTP + WS + compact 三条路径）：对齐真实 Codex CLI（`core/src/client.rs:874`），让上游 LB 能拿到稳定客户端身份做粘性路由提示。优先复用 `~/.codex/installation_id`，没有则在 `data/installation_id` 持久化新生成的 UUID（`src/proxy/installation-id.ts`、`src/proxy/codex-api.ts`、`src/proxy/codex-types.ts`、`src/proxy/ws-transport.ts`、`config/fingerprint.yaml`）
- `evaluateImplicitResume()` 取代 `shouldActivateImplicitResume()` 内部判定：返回 `{ active, reason }`，便于在拒绝时给出具体原因（`src/routes/shared/proxy-handler.ts`）。原 `shouldActivateImplicitResume()` 保持向后兼容，作为 `.active` 的薄包装

### Fixed

- Self-update 双重安全护栏（`src/self-update.ts`）：`applyProxySelfUpdate` 之前会无条件 `git checkout -- .` + `git pull origin master`，导致 ① 工作目录任何未提交改动被静默丢弃；② 在 `dev` 等非 master 分支上把 master 合进来，破坏 dev→master promote 流程。本地 dev 服跑着的时候每次 tsx watch 重启都会触发：新进程启动 → 10s 后 update check → `auto_update: true` → 把开发者刚保存的代码当垃圾扫掉。修复：进入 `applyProxySelfUpdate` 先校验 ① 当前分支必须是 `master`/`main`，② `git status --porcelain` 必须为空；任一失败立刻 abort 并返回错误，**不再调用** `git checkout -- .`
- Anthropic → Codex 工具 schema 转换：检测到 `name === "Read"` 时，在 `pages` 字段的 description 末尾追加 "Omit this field entirely for non-PDF files; do not pass an empty string."。上游 gpt-5.x 在生成 Read tool_use 时倾向于把可选 string 字段填成 `""` 而非省略，Claude Code harness 把 `pages: ""` 当作"已传入"走到 PDF 分支报错；改 description 是最轻量的引导（不破坏忠实转发原则、对其他工具零影响），幂等可重复调用
- `bump-electron.yml`：checkout 时显式 `ref: master`。default branch 切到 `dev` 之后，schedule 触发的 stable bump 落到 dev 工作树，`git push origin master --follow-tags` 报 `src refspec master does not match any` 连续 fail，stable 卡在 v2.0.66（2026-04-24）补不上来。修复后下一次 16:00 UTC 自动续上

### Changed

- `bump-electron-beta.yml` 触发改为定时 cron（每天 04:00 / 12:00 UTC，北京 12:00 / 20:00），不再随每次 dev push 即时打 beta tag。聚合多个 PR 进同一 beta，避免 beta channel 一天弹多次更新；紧急可手动 `gh workflow run bump-electron-beta.yml`
- Ollama bridge cleanup（#403 review followups, closes #405 #406 #407）：
  - `src/ollama/bridge.ts` 不再重复实现 `normalizeHostname` / `isLoopbackHostname`，统一从 `src/utils/host.ts` 引入；`shared/utils/host.ts` 改为薄 re-export 以兼容前端的现有 import (#405)
  - `proxyOpenAIRequest` 转发头扩展到 `Content-Type` / `Accept` / `User-Agent` / `X-Request-Id` / `traceparent` / `tracestate`（#403 review #2）；`/v1/*` 路径剥离改用 `path.replace(/^\/v1/, "")` 替代 `slice(3)`
  - `MAX_SSE_BUFFER` 重命名为 `MAX_SSE_BUFFER_CHARS` 并补注释，明确比较的是 String 的 UTF-16 code unit 数（#403 review #3）
  - `src/config-loader.ts` 5 段 `if (!raw.ollama) raw.ollama = {}` 合并为开头一次性兜底（#403 review #4）
  - `getOllamaBridgeStatus(config?)` 拆成 `getOllamaBridgeRuntimeStatus()` 与 `getOllamaBridgeStatusForConfig(config)`，调用方按需选择（#403 review #5）
  - `POST /admin/ollama-settings` 移除多余的 `checkApiKey`，与其他 admin POST 一致由 `dashboardAuth` 中间件统一鉴权（#406）
  - 删除根目录开发日志 `OLLAMA_BRIDGE_INTEGRATION.md`（Phase 1/2 scope 已并入 CHANGELOG，git 历史保留原文）

### Added

- 图像生成请求计数（成功 / 失败分流）：`AccountUsage` 新增 `image_request_count` / `image_request_failed_count`（含 window 维度）。请求时检测 `tools[].type === "image_generation"`，release 时按 `tool_usage.image_gen.output_tokens` 是否 > 0 分流到成功 / 失败计数；Free 账号被静默剥工具、上游 4xx/5xx、EmptyResponse 等失败路径也会写入 failed 计数。`/admin/usage-stats/summary` 新增 `total_image_request_count` / `total_image_request_failed_count`，Dashboard 用量页新增「Image Requests」卡片显示 `N ok · M failed`，AccountCard 在有图像活动时显示窗口请求成功 / 失败行
- 图像生成 token 独立计数：上游 `tool_usage.image_gen.{input_tokens, output_tokens}`（`gpt-image-2` 单独账）从前一直被丢弃，现在贯穿全链路 —— `parseResponseData` / `extractImageGenUsage` 解析、`AccountUsage` 累加（含 window 维度）、`UsageSnapshot` / `UsageBaseline` 持久化、`/admin/usage-stats/summary` 暴露 `total_image_input_tokens` / `total_image_output_tokens`、Dashboard 用量页新增「Image Tokens (in/out)」卡片，AccountCard 在该账号有图像消费时多显示一行窗口图像 token；老 `usage-history.json` 缺新字段以 0 兜底，向后兼容
- 图像生成真实压测：`tests/real/image-generation.test.ts`（vitest, `npm run test:real`）跑 `{gpt-5.4-mini, gpt-5.5} × {1024×1024, 3840×2160}` 矩阵，每组合 2 并发 × 2 轮断言 SSE 完整事件链 + 图片 base64 长度阈值 + `tool_usage.image_gen.output_tokens > 0`，最后校验 `/admin/usage-stats/summary` 的 image token 增量；`tests/bench/image-gen-bench.ts` 提供同矩阵的 p50/p95/min/max + 图像与主模型 token 均值 markdown 表
- Dashboard 用量统计新增「缓存命中率」卡片：聚合所有账号 `cached_tokens / input_tokens` 比例，附带绝对值提示。后端 `AccountUsage` 与 `UsageSnapshot` 持久化 cached tokens（含 window 维度），`/admin/usage-stats/summary` 与 `/history` 同步暴露 `total_cached_tokens` / `cached_tokens` 字段；老数据以 0 兜底
- 发版流程引入 `dev` 分支 + beta channel：`bump-electron-beta.yml` 在 dev push 时打 `vX.Y.Z-beta.SHA` tag 出预发布包；`promote-dev-to-master.yml` 每天 14:00 UTC 检查 dev soak ≥24h + CI 绿后 fast-forward 到 master，再由现有 `bump-electron.yml` 出 stable tag (`.github/workflows/`)
- `update.allow_prerelease` 配置项（默认 `false`）：开启后本地 Electron 通过 electron-updater 接收 beta channel 推送的预发布版本，便于自己的安装实测 dev 改动 (`src/config-schema.ts`、`packages/electron/electron/auto-updater.ts`、`config/default.yaml`)
- `config/models.yaml`: `gpt-5.5` (Plus-only general-purpose chat) and `gpt-image-2` (Plus-only image-generation backend) entered the static catalog
- `CodexModelInfo.outputModalities` optional field on the model catalog interface to flag image-gen models apart from chat models (`src/models/model-store.ts`, `BackendModelEntry.output_modalities` also added for backend passthrough). `/v1/models/catalog` defaults missing values to `["text"]` so API output matches the documented contract.
- README 新增图像生成小节 + 模型表 Output 列；`API.md` / `API_CN.md` 补 `image_generation` 工具参数矩阵、事件流、编辑模式文档
- Dashboard: new Logs tab to inspect ingress/egress requests, with enable/pause controls, filters, search, and details panel.
- 控制台新增日志页面：支持启用/暂停、方向筛选、搜索与详情查看，便于排查请求流向。
- `auth.tier_priority` 配置项：按 plan 类型排序账号选择优先级（如 `["plus", "pro", "team", "free"]`），高优先级 tier 的账号在有可用时始终优先选择；默认 `null`（不启用），与所有轮转策略兼容 (#348)

- `server.trust_proxy` config option (default `false`): when enabled, the real client IP is read from `X-Forwarded-For` / `X-Real-IP` headers instead of the raw socket address. Required for users who expose codex-proxy via tunnel software (frp, ngrok, etc.) so that dashboard auth works correctly — previously all tunnel traffic appeared as `127.0.0.1` and bypassed authentication even when `proxy_api_key` was set (#350)

### Fixed

- 多后端流量的 cache 命中率被低估到 0%：`OpenAI` / `Anthropic` / `Gemini` 上游适配器在合成 `response.completed` 时全都硬编码 `input_tokens_details: {}`,丢掉了上游原本返回的缓存字段。`openai-upstream.ts` 现在抽 `usage.prompt_tokens_details.cached_tokens`,`anthropic-upstream.ts` 抽 `message_start.usage.cache_read_input_tokens`(也兜底从 `message_delta.usage` 读),`gemini-upstream.ts` 抽 `usageMetadata.cachedContentTokenCount`。修复后 `/admin/usage-stats/summary` 的 `total_cached_tokens` 在多后端模式下不再常驻 0,Dashboard 缓存命中率卡片可以正常工作
- Dashboard 缓存命中率显示精度自适应:`formatHitRate` 在 < 1% 时切两位小数(`0.02%`),< 0.01% 显 `<0.01%`,= 0 显 `0%` —— 以前 `pct.toFixed(1)` 把 < 0.05% 全压成 "0.0%",看不到真实值
- 上游返回 `previous_response_not_found`(response 由别的账号创建 / `SessionAffinityMap` 过期或重启丢失 / 跨账号轮转)时端到端恢复:
  - `ws-transport.ts:36` `ROTATABLE_ERROR_CODES` 增补 `previous_response_not_found: 400`，让 WS 首帧 in-stream error 转成 `CodexApiError` reject —— 之前因为不在白名单里直接被流式透传到客户端，绕过了 catch
  - `proxy-handler.ts` catch 块新增 strip-and-retry：剥掉 `previous_response_id` + `turnState`，在同一账号上重试一次，并把 ID 从 affinity map 清掉防止后续请求继续命中错路由；重试仍失败时降级返回原错误
  - 隐式续链场景通过已有的 `restoreImplicitResumeRequest()` 路径回放完整 input，无损恢复；显式续链（客户端传 `previous_response_id`）会丢服务端历史，但请求仍能完成
  - 新增分类器 `isPreviousResponseNotFoundError` + `SessionAffinityMap.forget()`（`src/proxy/error-classification.ts`、`src/auth/session-affinity.ts`、`src/routes/shared/proxy-handler.ts`、`src/proxy/ws-transport.ts`）
- `release.yml` 让 electron-builder 用 tag 名当版本（`--config.extraMetadata.version="${TAG#v}"`），不再依赖 `package.json`。修复 `bump-electron-beta.yml` 故意不写 `package.json` 时 beta 包被跳过上传的问题（"existing type not compatible with publishing type"）；同步在 `release` job 给 prerelease tag 兜底 `--prerelease` flag (#413)
- `release.yml` 的 `Pack` 步骤强制 `shell: bash`，让 Windows runner（默认 pwsh）正确解析 bash 多行续行符 `\` (#414)
- WebSocket 路径首帧若为上游 `usage_limit_reached` / `rate_limit*` / `quota_exhausted` / 鉴权类终止错误，转换为 `CodexApiError` 抛出，复用 HTTP 路径已有的账号轮转逻辑；恢复 2.0.62 的"智能切换"行为（`src/proxy/ws-transport.ts`）。错误若发生在已有内容流出之后，仍按当前行为透传给客户端
- 无可用账号时不再执行无意义的重试，直接返回描述性错误信息（含各状态账号计数：rate-limited / expired / banned / disabled）(#362)
- API Key 路由（OpenAI/Anthropic/Gemini）上游返回错误时，透传原始 JSON 响应体，而非包装为代理自有格式；Codex 账号路由仍使用代理格式 (#367)

- `least_used` 策略不再将 `window_reset_at = null` 的新账号（从未收到限速响应头）视为 Infinity 而永久排在已有窗口账号之后；现在两者都进入 `request_count` 比较，新账号（0 请求）可正确轮转到，`__cf_bm` cookie 也能正常写入 (#342)

- 默认不再发送 `reasoning.effort`：移除 `modelInfo.defaultReasoningEffort` 自动兜底，`default_reasoning_effort` 默认改为 `null`，彻底消除简单对话触发 medium 推理导致的 token 暴涨；Dashboard 新增 "Disabled (no reasoning)" 选项，用户可按需开启

- 上游 401 时立即触发 RT→AT 刷新，而非等待定时器（修复 token 被提前作废后账号一直显示 expired 的问题）
- Dashboard session 滑动窗口续期：每次有效请求自动延长过期时间，不再固定 TTL 后断连
- Dashboard 前端全局 401 拦截：session 过期后自动跳回登录页，不再卡死在空白页
- Add Account 对话框新增 Cancel 按钮，OAuth 流程中可随时关闭对话框 (#319)
- Electron 打包前清空旧 public/ 目录，防止残留旧版前端资源导致显示异常 (#320)

### Changed

- Default model switched from `gpt-5.3-codex` → `gpt-5.4` (`config/default.yaml`, `config/models.yaml.isDefault`, Zod schema default in `src/config-schema.ts`). Removed the `codex` alias — clients must use full model IDs. Sonnet mapping in Anthropic preset/README 推荐表保持 `gpt-5.3-codex` 不变（编程场景更贴位）
- Static `isDefault` and `outputModalities` on `config/models.yaml` entries now survive the backend dynamic fetch merge (previously the spread of normalized `undefined`/`false` silently clobbered YAML-declared values)
- Dashboard session TTL 由 `session.ttl_minutes` 控制；当前默认配置为 60 分钟

### Added

- 第三方 API Key 管理：支持 Anthropic / OpenAI / Gemini / OpenRouter 预设模型 + 自定义 provider，每个 key 绑定一个具体模型，运行时动态路由（优先于 config 固定 key），LRU 轮转多 key 负载均衡
  - REST API：`GET/POST /auth/api-keys`、`GET /auth/api-keys/catalog`、`POST /auth/api-keys/import`、`GET /auth/api-keys/export`、批量删除、label/status 管理
  - Dashboard 新增 API Keys tab：表单添加（御三家下拉选模型 / custom 手填）、import/export、toggle 启停、删除
  - 持久化 `data/api-keys.json`，UpstreamRouter 优先级 0 匹配 pool entry
- 加强伪装：Rust native transport（reqwest + rustls），TLS 指纹精确匹配真实 Codex Desktop；补齐 `x-openai-internal-codex-residency`、`x-client-request-id`、`x-codex-turn-state` 请求头
- 账号探活：`POST /auth/accounts/health-check` 批量健康检查 + `POST /auth/accounts/:id/refresh` 单账号刷新，通过 OAuth refresh 探测存活状态，带 stagger 延迟和并发控制
- Session affinity：同一对话链路由到同一账号，修复 `previous_response_id` 跨账号失效问题
- `prompt_cache_key`：每个对话链生成唯一 UUID 传递给后端，启用 prompt cache
- WebSocket 请求新增 `include: ["reasoning.encrypted_content"]`（reasoning 开启时自动设置）
- 请求级监控日志：affinity hit/miss、payload 大小、usage 统计、大 payload 告警
- E2E 测试：proxy-routes（36 cases）、dashboard-auth（9）、batch-label（11）、admin-general（11）、debug-routes（5）—— 覆盖率从 51% 提升至 ~75%
- 单元测试：config-loader（16 cases）、config-schema（10）、codex-models（9）
- account-import service 测试补充 RT rotation/fallback 2 cases

### Fixed

- 修复 `service_tier` 在 WebSocket 和 HTTP 两条路径均被丢弃的 bug — 现在正确转发给后端
- 修复 `PUT /api/proxies/settings` 被 `PUT /api/proxies/:id` 路由参数 shadow 的 bug（Hono 按注册顺序匹配）

### Changed

- 删除冗余测试文件：`self-update-auto.test.ts`（superset 覆盖）、`account-import-refresh.test.ts`（迁移到 service 层）
- 重命名 `model-plan-routing.test.ts` → `plan-routing-integration.test.ts` 以区分作用域
- libcurl FFI 连接复用：macOS/Linux 自动构建 dylib，通过 CURLSH 共享连接缓存 + SSL session，消除每次请求的 TCP/TLS 握手开销（~2.9s → ~100-300ms）
- setup 脚本自动下载静态库、编译 C wrapper、生成 dylib + cacert.pem
- 自动更新（热更新）功能，默认开启，用户可在 Dashboard 设置中关闭
  - Git 模式：检测到更新后自动 pull → install → build → 重启
  - Electron (Win/Linux)：自动下载更新，退出时安装；dock/任务栏显示下载进度条
  - Electron (macOS)：自动打开 release 页面（平台限制无法自动安装）
  - 配置项 `update.auto_update`，持久化到 `data/local.yaml`

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
- Dashboard 改为 4-tab 布局（概览/管理账号/代理分配/设置），设置面板从首页移至独立 tab，首页保留账号卡片 + 代理池
- AccountCard 响应式修复：窄屏时操作按钮自动换行不再溢出

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
- Claude Code Setup 卡片：Dashboard 按 Opus/Sonnet/Haiku/自定义 层级一键复制环境变量（推荐模型 gpt-5.4 / gpt-5.3-codex / gpt-5.4-mini）
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
