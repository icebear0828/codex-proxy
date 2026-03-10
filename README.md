<div align="center">

  <h1>Codex Proxy</h1>
  <h3>您的本地 Codex 编程助手中转站</h3>
  <p>将 Codex Desktop 的能力以 OpenAI 标准协议对外暴露，无缝接入任意 AI 客户端。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-快速开始-quick-start">快速开始</a> •
    <a href="#-核心功能-features">核心功能</a> •
    <a href="#-技术架构-architecture">技术架构</a> •
    <a href="#-客户端接入-client-setup">客户端接入</a> •
    <a href="#-配置说明-configuration">配置说明</a>
  </p>

  <p>
    <strong>简体中文</strong> |
    <a href="./README_EN.md">English</a>
  </p>

</div>

---

**Codex Proxy** 是一个轻量级本地中转服务，将 [Codex Desktop](https://openai.com/codex) 的 Responses API 转换为 OpenAI 标准的 `/v1/chat/completions` 接口。通过本项目，您可以在 Cursor、Continue、VS Code 等任何兼容 OpenAI 协议的客户端中直接使用 Codex 编程模型。

只需一个 ChatGPT 账号，配合本代理即可在本地搭建一个专属的 AI 编程助手网关。

## 🚀 快速开始 (Quick Start)

### 桌面应用（最简单）

从 [GitHub Releases](https://github.com/icebear0828/codex-proxy/releases) 下载安装包，开箱即用：

| 平台 | 安装包 |
|------|--------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

安装后打开应用，使用 ChatGPT 账号登录即可。桌面端默认监听 `127.0.0.1:8080`，仅本机访问。

### CLI / 服务器部署

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
```

### Docker（推荐，所有平台通用）

```bash
cp .env.example .env       # 创建环境变量文件（可编辑配置）
docker compose up -d
# 打开 http://localhost:8080 登录
```

数据持久化通过 volume 映射：`data/`（账号、Cookie）和 `config/`（配置文件）。

> **跨容器访问提示**：如果其他 Docker 容器（如 OpenClaw、Cursor Server 等）需要连接 codex-proxy，建议使用宿主机的局域网 IP（如 `http://192.168.x.x:8080/v1`）而非 `host.docker.internal`，以避免 Docker DNS 解析问题。

### macOS / Linux

```bash
npm install                # 安装后端依赖 + 自动下载 curl-impersonate
cd web && npm install && cd ..   # 安装前端依赖
npm run dev                # 开发模式（热重载）
# 或：npm run build && npm start  # 生产模式
```

> 也支持 `pnpm` 或 `bun`，将上方 `npm` 替换即可。

### Windows

```bash
npm install                # 安装后端依赖
cd web && npm install && cd ..   # 安装前端依赖
npm run dev                # 开发模式（热重载）
```

> Windows 下 curl-impersonate 暂不可用，自动降级为系统 curl（无 Chrome TLS 伪装）。建议搭配本地代理使用，或通过 Docker / WSL 部署以获得完整 TLS 伪装能力。

### 验证

```bash
# 打开 http://localhost:8080 使用 ChatGPT 账号登录，然后：
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## 🌟 核心功能 (Features)

### 1. 🔌 全协议兼容 (Multi-Protocol API)
- 完全兼容 `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）和 Gemini 格式
- 支持 SSE 流式输出，可直接对接所有 OpenAI SDK 和客户端
- 自动完成 Chat Completions ↔ Codex Responses API 双向协议转换

### 2. 🔐 账号管理与智能轮换 (Auth & Multi-Account)
- **OAuth PKCE 登录** — 浏览器一键授权，无需手动复制 Token
- **多账号轮换** — 支持 `least_used`（最少使用优先）和 `round_robin`（轮询）两种调度策略
- **Token 自动续期** — JWT 到期前自动刷新，指数退避重试（5 次），临时失败 10 分钟恢复调度
- **配额实时监控** — 控制面板展示各账号剩余用量，限流窗口滚动时自动重置计数器
- **关键数据即时持久化** — 新增/刷新 Token 立即写盘，不丢失
- **稳定连接** — 自动对齐 Codex Desktop 请求特征，Cookie 持久化减少重复验证
- **Web 控制面板** — 账号管理、用量监控、状态总览，中英双语

### 3. 🌐 代理池 (Proxy Pool)
- **Per-Account 代理路由** — 为不同账号配置不同的上游代理，实现 IP 多样化和风险隔离
- **四种分配模式** — Global Default（全局代理）、Direct（直连）、Auto（Round-Robin 轮转）、指定代理
- **健康检查** — 定时（默认 5 分钟）+ 手动，通过 ipify API 获取出口 IP 和延迟
- **不可达自动标记** — 代理不可达时自动标记为 unreachable，不参与自动轮转
- **Dashboard 管理面板** — 添加/删除/检查/启用/禁用代理，每个账号可选择代理或模式

## 🏗️ 技术架构 (Architecture)

```
                            Codex Proxy
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Client (Cursor / Continue / SDK)                   │
│       │                                             │
│  POST /v1/chat/completions                          │
│  POST /v1/messages (Anthropic)                      │
│       │                                             │
│       ▼                                             │
│  ┌──────────┐    ┌───────────────┐    ┌──────────┐  │
│  │  Routes   │──▶│  Translation  │──▶│  Proxy   │  │
│  │  (Hono)  │   │ OpenAI→Codex  │   │ curl TLS │  │
│  └──────────┘   └───────────────┘   └────┬─────┘  │
│       ▲                                   │        │
│       │          ┌───────────────┐        │        │
│       └──────────│  Translation  │◀───────┘        │
│                  │ Codex→OpenAI  │  SSE stream     │
│                  └───────────────┘                  │
│                                                     │
│  ┌──────────┐  ┌───────────────┐  ┌─────────────┐  │
│  │   Auth   │  │  Fingerprint  │  │   Session   │  │
│  │ OAuth/JWT│  │  Headers/UA   │  │   Manager   │  │
│  └──────────┘  └───────────────┘  └─────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  Auto-Maintenance (update-checker + scripts) │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
                         │
                    curl subprocess
                    (Chrome TLS)
                         │
                         ▼
                    chatgpt.com
              /backend-api/codex/responses
```

## 📦 可用模型 (Available Models)

| 模型 ID | 别名 | 推理等级 | 说明 |
|---------|------|---------|------|
| `gpt-5.4` | `codex` | minimal / low / medium / high | 最新旗舰编程模型（默认） |
| `gpt-5.3-codex` | — | low / medium / high | 上一代旗舰 agentic 编程模型 |
| `gpt-5.3-codex-spark` | — | minimal / low | 超轻量编程模型 |
| `gpt-5.2-codex` | — | low / medium / high | agentic 编程模型 |
| `gpt-5.1-codex-max` | `codex-max` | low / medium / high | 深度推理编程模型 |
| `gpt-5.1-codex-mini` | `codex-mini` | low / medium / high | 轻量快速编程模型 |

> **模型名后缀**：在任意模型名后追加 `-fast` 启用 Fast 模式，追加 `-high`/`-low` 等切换推理等级。
> 例如：`gpt-5.4-fast`、`gpt-5.4-high-fast`、`codex-fast`。
>
> 模型列表会随 Codex Desktop 版本更新自动同步。后端也会动态获取最新模型目录。

## 🔗 客户端接入 (Client Setup)

### Claude Code

在终端设置环境变量，即可让 Claude Code 通过 codex-proxy 使用 Codex 模型：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# 默认 Opus 4.6 → gpt-5.4，无需设置 ANTHROPIC_MODEL
# 如需切换模型或启用后缀：
# export ANTHROPIC_MODEL=codex-fast              # → gpt-5.4 + Fast 模式
# export ANTHROPIC_MODEL=gpt-5.4-high            # → gpt-5.4 + high 推理
# export ANTHROPIC_MODEL=gpt-5.4-high-fast       # → gpt-5.4 + high + Fast
# export ANTHROPIC_MODEL=claude-sonnet-4-6       # Sonnet → gpt-5.3-codex
# export ANTHROPIC_MODEL=claude-haiku-4-5-20251001  # Haiku → gpt-5.1-codex-mini

claude   # 启动 Claude Code
```

| Claude Code 模型 | 映射到 Codex 模型 | 说明 |
|------------------|------------------|------|
| Opus (默认) | `gpt-5.4` | 无需设置 `ANTHROPIC_MODEL` |
| Sonnet (`claude-sonnet-4-6`) | `gpt-5.3-codex` | |
| Haiku (`claude-haiku-4-5-20251001`) | `gpt-5.1-codex-mini` | |

> 也可以在控制面板 (`http://localhost:8080`) 的 **Anthropic SDK Setup** 卡片中一键复制环境变量。

### Cursor

Settings → Models → OpenAI API Base:
```
http://localhost:8080/v1
```

API Key（从控制面板获取）:
```
your-api-key
```

### Continue (VS Code)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "codex",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-api-key"
)

response = client.chat.completions.create(
    model="codex",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### OpenAI Node.js SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "your-api-key",
});

const stream = await client.chat.completions.create({
  model: "codex",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## ⚙️ 配置说明 (Configuration)

所有配置位于 `config/default.yaml`：

| 分类 | 关键配置 | 说明 |
|------|---------|------|
| `server` | `host`, `port`, `proxy_api_key` | 服务监听地址与 API 密钥（见下方说明） |
| `api` | `base_url`, `timeout_seconds` | 上游 API 地址与请求超时 |
| `client` | `app_version`, `build_number`, `chromium_version` | 模拟的 Codex Desktop 版本与 Chromium 版本 |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier` | 默认模型、推理强度与速度模式 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 轮换策略与限流退避 |
| `tls` | `curl_binary`, `impersonate_profile`, `proxy_url`, `force_http11` | TLS 伪装与代理配置 |

#### TLS 配置选项

```yaml
tls:
  curl_binary: auto                # curl 二进制路径（auto 自动检测）
  impersonate_profile: chrome136   # Chrome 伪装版本
  proxy_url: null                  # 代理地址（null 自动检测本地代理）
  force_http11: false              # 强制使用 HTTP/1.1（解决代理不支持 HTTP/2 的问题）
```

**`force_http11`**：当你的代理（如 Clash/mihomo）出现以下错误时启用：
```
curl: (16) Remote peer returned unexpected data while we expected SETTINGS frame.
Perhaps, peer does not support HTTP/2 properly.
```

### API 密钥 (proxy_api_key)

在 `config/default.yaml` 中设置客户端访问代理时使用的 API Key：

```yaml
server:
  proxy_api_key: "pwd"          # 自定义密钥，客户端请求时使用此值
  # proxy_api_key: null          # 设为 null 则自动生成 codex-proxy-xxxx 格式的密钥
```

- **自定义密钥**：设置为任意字符串（如 `"pwd"`），客户端使用 `Authorization: Bearer pwd` 访问
- **自动生成**：设为 `null`，代理会根据账号信息自动生成一个 `codex-proxy-` 前缀的哈希密钥
- 当前密钥始终显示在控制面板（`http://localhost:8080`）的 API Configuration 区域

### 环境变量覆盖

| 环境变量 | 覆盖配置 |
|---------|---------|
| `PORT` | `server.port` |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `HTTPS_PROXY` | `tls.proxy_url` |

## 📡 API 端点一览 (API Endpoints)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全 — OpenAI 格式（核心端点） |
| `/v1/messages` | POST | 聊天补全 — Anthropic 格式 |
| `/v1/models` | GET | 可用模型列表 |
| `/health` | GET | 健康检查 |
| `/auth/accounts` | GET | 账号列表（`?quota=true` 含配额） |
| `/auth/accounts/login` | GET | OAuth 登录入口 |
| `/debug/fingerprint` | GET | 调试：查看当前伪装头信息 |
| `/api/proxies` | GET | 代理池列表（含分配信息） |
| `/api/proxies` | POST | 添加代理（HTTP/HTTPS/SOCKS5） |
| `/api/proxies/:id` | PUT | 更新代理配置 |
| `/api/proxies/:id` | DELETE | 删除代理 |
| `/api/proxies/:id/check` | POST | 单个代理健康检查 |
| `/api/proxies/:id/enable` | POST | 启用代理 |
| `/api/proxies/:id/disable` | POST | 禁用代理 |
| `/api/proxies/check-all` | POST | 全部代理健康检查 |
| `/api/proxies/assign` | POST | 为账号分配代理 |
| `/api/proxies/assign/:accountId` | DELETE | 取消账号代理分配 |
| `/api/proxies/settings` | PUT | 更新代理池全局设置 |

## 🔧 命令 (Commands)

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式启动（热重载） |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm start` | 运行编译后的生产版本 |
| `npm run update` | 手动触发完整更新流水线 |

## 📋 系统要求 (Requirements)

- **Node.js** 18+（推荐 20+）
- **curl** — 系统自带即可；`npm install` 自动下载 curl-impersonate 获得完整 Chrome TLS 伪装
- **ChatGPT 账号** — 普通免费账号即可
- **Docker**（可选） — 推荐使用 Docker 部署

## ⚠️ 注意事项 (Notes)

- Codex API 为**流式输出专用**，设置 `stream: false` 时代理会内部流式收集后返回完整 JSON
- 本项目依赖 Codex Desktop 的公开接口，上游版本更新时会自动检测并更新指纹
- `config/default.yaml` 中的注释在自动更新后会丢失（使用结构化 YAML 写入）

## 📝 最近更新 (Recent Changes)

> 完整更新日志请查看 [CHANGELOG.md](./CHANGELOG.md)，以下内容由 CI 自动同步。

<!-- CHANGELOG:START -->
### [Unreleased]

- 更新弹窗 + 自动重启：点击"有可用更新"弹出 Modal 显示 changelog，一键更新后服务器自动重启、前端自动刷新，零人工干预（git 模式 spawn 新进程、Docker/Electron 显示对应操作指引）

### [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

- 原生 function_call / tool_calls 支持（所有协议）

### [v0.7.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.7.0) - 2026-02-22

- `developer` 角色支持（OpenAI 协议）
- 数组格式 content 支持
- tool / function 消息兼容（所有协议）
- 模型响应中自动过滤 Codex Desktop 指令
<!-- CHANGELOG:END -->

## 📄 许可协议 (License)

本项目采用 **非商业许可 (Non-Commercial)**：

- **允许**：个人学习、研究、自用部署
- **禁止**：任何形式的商业用途，包括但不限于出售、转售、收费代理、商业产品集成

本项目与 OpenAI 无关联。使用者需自行承担风险并遵守 OpenAI 的服务条款。

---

<div align="center">
  <sub>Built with Hono + TypeScript | Powered by Codex Desktop API</sub>
</div>
