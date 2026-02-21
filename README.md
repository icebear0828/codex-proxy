<div align="center">

  <h1>Codex Proxy</h1>
  <h3>您的本地 Codex 编程助手中转站</h3>
  <p>将 Codex Desktop 的能力以 OpenAI 标准协议对外暴露，无缝接入任意 AI 客户端。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-快速开始-quick-start">快速开始</a> •
    <a href="#-核心功能-features">核心功能</a> •
    <a href="#-技术架构-architecture">技术架构</a> •
    <a href="#-部署方式-deployment">部署方式</a> •
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

```bash
# 1. 克隆仓库
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy

# 2. 安装依赖（也支持 pnpm / bun）
npm install
cd web && npm install && cd ..

# 3. 启动代理（开发模式，支持热重载）
npm run dev

# 4. 打开浏览器访问控制面板，使用 ChatGPT 账号登录
#    http://localhost:8080

# 5. 测试请求
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

### 3. 🛡️ 稳定连接 (Stable Connection)
- **桌面级请求模拟** — 自动对齐 Codex Desktop 的请求特征，确保连接稳定
- **Cookie 持久化** — 会话状态自动保存，减少重复验证

### 4. 🔄 自动维护 (Auto-Maintenance)
- **版本自动同步** — 检测到 Codex Desktop 新版本后自动更新配置，无需手动操作
- **配置热重载** — 更新完成后自动生效，无需重启
- **多轮对话关联** — 自动维护上下文，保持对话连贯
- **Web 控制面板** — 账号管理、用量监控、状态总览，中英双语

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

| 模型 ID | 别名 | 说明 |
|---------|------|------|
| `gpt-5.3-codex` | `codex` | 最新旗舰 agentic 编程模型（默认） |
| `gpt-5.2-codex` | — | 上一代 agentic 编程模型 |
| `gpt-5.1-codex-max` | `codex-max` | 深度推理编程模型 |
| `gpt-5.2` | — | 通用旗舰模型 |
| `gpt-5.1-codex-mini` | `codex-mini` | 轻量快速编程模型 |

> 模型列表会随 Codex Desktop 版本更新自动同步。

## 🔗 客户端接入 (Client Setup)

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

## 🐳 部署方式 (Deployment)

### Docker 部署（推荐，所有平台通用）

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
docker compose up -d
# 打开 http://localhost:8080 登录
```

数据持久化通过 volume 映射：`data/`（账号、Cookie）和 `config/`（配置文件）。

### 原生部署（macOS / Linux）

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install && cd web && npm install && cd .. && npm run build && npm start  # 也支持 pnpm / bun
# 打开 http://localhost:8080 登录
```

> Docker 部署自动安装 curl-impersonate（Linux 版）和 unzip（自动更新用）。原生部署依赖 `npm install` 的 postinstall 脚本自动下载 curl-impersonate。

## ⚙️ 配置说明 (Configuration)

所有配置位于 `config/default.yaml`：

| 分类 | 关键配置 | 说明 |
|------|---------|------|
| `server` | `host`, `port`, `proxy_api_key` | 服务监听地址与 API 密钥（见下方说明） |
| `api` | `base_url`, `timeout_seconds` | 上游 API 地址与请求超时 |
| `client` | `app_version`, `build_number`, `chromium_version` | 模拟的 Codex Desktop 版本与 Chromium 版本 |
| `model` | `default`, `default_reasoning_effort` | 默认模型与推理强度 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 轮换策略与限流退避 |
| `tls` | `curl_binary`, `impersonate_profile`, `proxy_url` | TLS 伪装与代理配置 |

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
- 建议在 **Linux / macOS** 上部署以获得完整 TLS 伪装能力（Windows 下 curl-impersonate 暂不可用，降级为系统 curl）
- `config/default.yaml` 中的注释在自动更新后会丢失（使用结构化 YAML 写入）

## 📄 许可协议 (License)

本项目采用 **非商业许可 (Non-Commercial)**：

- **允许**：个人学习、研究、自用部署
- **禁止**：任何形式的商业用途，包括但不限于出售、转售、收费代理、商业产品集成

本项目与 OpenAI 无关联。使用者需自行承担风险并遵守 OpenAI 的服务条款。

---

<div align="center">
  <sub>Built with Hono + TypeScript | Powered by Codex Desktop API</sub>
</div>
