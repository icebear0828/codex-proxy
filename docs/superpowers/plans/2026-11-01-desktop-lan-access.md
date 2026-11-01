# Desktop LAN Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通用户通过桌面端开关配置局域网访问，保存、重启后可复制准确的 API 地址。

**Architecture:** 复用 GeneralSettings 的逐项保存与 local.yaml 覆盖机制。设置接口区分持久化 host 与实际运行监听状态，通过每个服务实例的 getter 提供真实端口；地址枚举独立成小工具，不引入依赖。

**Tech Stack:** TypeScript、Hono、Node.js os.networkInterfaces、Preact、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-01-desktop-lan-access-design.md`（用户已批准）。

## Global Constraints

- 默认关闭；开启写入 0.0.0.0，关闭写入 127.0.0.1，完全退出并重新打开应用后生效。
- 开启要求已配置非空且非默认 pwd 的管理密钥；不自动替换密钥。
- 不修改防火墙、trust_proxy、鉴权语义；不发送真实模型请求。
- 保留自定义 host 和其他 YAML 字段，只有用户明确保存才覆盖 host。
- 桌面端入口，中英文文案，保留项目现有技术栈；单 Agent 执行。
- 文档路径被忽略且本机未配置 Git 提交身份：不强制添加文档，不猜测身份，不自动提交；代码完成后交付工作区 diff。

## Review Focus

- 多网卡、重复地址和无 IPv4：地址去重，保留各可用候选，空列表有明确说明。
- 保存配置但未重启：旧运行状态不能显示为已开启。
- 端口占用导致 Electron 使用随机端口：复制地址必须使用实际端口。
- 已有自定义 IPv4/IPv6 host：进入设置不覆盖原值，并显示自定义状态。
- 保存失败、无密钥、默认密钥：不能显示成功或误导用户已生效。

## 文件与职责

- 新增 `src/utils/lan-access.ts`：监听状态类型及 IPv4 地址枚举。
- 修改 `src/index.ts`、`src/routes/web.ts`：将当前服务的真实监听状态 getter 注入设置路由，不使用跨实例全局状态。
- 修改 `src/routes/admin/settings.ts`：host 读取、布尔开关保存、密钥校验与运行状态返回。
- 修改 `shared/hooks/use-general-settings.ts`：字段类型、保存响应和状态刷新。
- 修改 `web/src/components/GeneralSettings.tsx`：桌面端开关、待生效提示、地址与复制操作。
- 修改 `shared/i18n/translations.ts`：中英文标签及说明。
- 测试：`tests/unit/utils/lan-access.test.ts`、`tests/unit/routes/general-settings.test.ts`、`web/src/components/GeneralSettings.test.tsx`；启动集成验证沿用项目现有 server 启动测试夹具。

### Task 1: 设置接口与真实运行状态

**Interfaces:**
- `LanRuntimeState = { host: string; port: number }`。
- `listLanIpv4Addresses(interfaces: ReturnType<typeof networkInterfaces>): string[]`，实现于 lan-access.ts，过滤 internal、非 IPv4，去重并稳定排序。
- `createSettingsRoutes(accountPool?, getLanRuntime?: () => LanRuntimeState | null)`；createWebRoutes 增加末尾可选参数传递该 getter，现有调用者保持兼容。
- GET/POST `/admin/general-settings` 返回新增字段：`host: string`、`lan_access: boolean`（仅 host 为 0.0.0.0 时为 true）、`lan_runtime: LanRuntimeState | null`、`lan_ipv4_addresses: string[]`。
- POST 新增 `lan_access?: boolean`，不开放任意 host 写入。运行 getter 尚未就绪时返回 null，不用配置值冒充实际监听。

- [ ] 写失败测试：枚举重复/多个/无地址；GET 返回自定义 host 原值；POST true/false 分别持久化指定 host；非布尔返回 400 且不写文件；null、空白、pwd 密钥拒绝开启；有效密钥允许；不相关保存不得改 host；mutateYaml 失败返回失败响应。
- [ ] 运行 `npx vitest run tests/unit/utils/lan-access.test.ts tests/unit/routes/general-settings.test.ts`，确认新增行为失败。
- [ ] 实现类型、枚举、getter 注入及接口字段。密钥检查对 trim 后值执行；不将密钥加入新增响应。启动监听后从 server.address() 获取地址与实际端口，同源用于 ServerHandle.port 和 getter；关闭时清空运行状态。
- [ ] host 变更沿用 mutateYaml/reloadAllConfigs；restart_required 的新增条件是保存 host 与运行 host 不同（缺少运行状态时和变更前 host 比较）。保留已有其他设置的重启条件。
- [ ] 补启动测试：请求端口 0 时 getter.port 等于实际绑定端口且非零；保存 host 后 getter 仍返回原监听地址；实例间状态不串扰。禁止真实账号请求，mock 后台调度器和上游。
- [ ] 重跑定向测试，要求全部通过；检查新增字段仅经现有受保护的设置接口返回。

### Task 2: 桌面端设置交互

**Interfaces:** 消费 Task 1 字段。hook 类型复用 LanRuntimeState 的结构（共享类型不得令浏览器导入 Node 运行时代码），组件根据配置显示编辑值，根据 lan_runtime 显示运行状态。

- [ ] 写失败组件测试：非桌面隐藏开关；默认关闭；修改后仅点击保存才提交 `{ lan_access: true/false }`；自定义 host 显示说明且不自动保存；保存失败保留草稿并显示错误。
- [ ] 增加状态测试：已保存开启但 runtime.host 为 127.0.0.1 时显示待重启且不显示可用地址；运行在 0.0.0.0 时为每个 IPv4 生成 `http://<IP>:<runtime.port>/v1`；复制内容正确；无地址有说明；runtime 为 null 时不声称已生效。使用 mock clipboard 和 mock fetch。
- [ ] 运行 `npm run test:web -- src/components/GeneralSettings.test.tsx`，确认新测试失败。
- [ ] 扩展 hook 读取和保存字段，刷新后保留配置/运行状态差异；复用 SettingItemControl 实现桌面专属开关及保存状态。
- [ ] 添加中英文文案：允许局域网访问、仅本机、自定义监听地址、完全退出并重新打开后生效、可信网络与防火墙说明、未设置有效管理密钥时引导现有密钥设置。说明全网卡监听不保证同子网隔离；不把密钥嵌入 URL。
- [ ] 实现地址列表与复制反馈（复制失败显示错误），重跑组件测试全部通过。

### Task 3: 验收与交付

- [ ] 运行 `npx vitest run tests/unit/utils/lan-access.test.ts tests/unit/routes/general-settings.test.ts` 与 Task 1 实际新增启动测试；要求全部通过。
- [ ] 运行 `npm run test:web -- src/components/GeneralSettings.test.tsx src/components/settings/__tests__/SettingItemControl.test.tsx`；要求全部通过。
- [ ] 运行 `npx tsc --noEmit`、`npm run build:web`、`git diff --check`；要求退出码为 0。
- [ ] 使用隔离临时配置和 mock 上游检查开启/关闭重启后的监听与地址显示。不改用户实际 local.yaml、系统防火墙或密钥，不运行 test:real。
- [ ] 只读复核鉴权未放宽、YAML 无关字段未覆盖、Electron 回退端口准确、文案区分已保存与已生效。按发现的问题补必要回归测试。
- [ ] 汇报修改文件、测试结果与未能验证的跨设备网络限制；不自动 push、开 PR 或改提交身份。

## 自查结果

设计要求均已分配至任务；五项 Review Focus 各有对应测试。无需新增依赖或操作系统权限，按顺序单 Agent 执行，避免多个执行体重复读取同一合同域。

## 执行结果

已完成后端、桌面 UI 和针对性验证：后端与实际 socket 测试 48 项、前端 21 项通过；根目录 TypeScript、Web 构建、diff 格式检查通过。Chrome 模拟数据预览通过，未运行真实账号或跨设备访问。Web 独立 TypeScript 检查仅余原有 AddAccount.tsx 的 confirm 翻译键错误（HEAD 已存在该引用，翻译表无该键）。

实施调整：LAN UI 独立为 LanAccessSettings；地址读取使用每实例真实 socket，LAN 待重启判断仅比较 host，避免端口回退造成误报；补齐五种现有语言。按单 Agent 范围完成自行复核，不创建审查子 Agent。用户后续已授权提交全部改动、合入 dev 并推送；提交身份已由用户提供并配置于当前仓库。
