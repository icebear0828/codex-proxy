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

> **前置条件**：你需要一个 ChatGPT 账号（免费账号即可）。如果还没有，先去 [chat.openai.com](https://chat.openai.com) 注册一个。

---

### 方式一：桌面应用（推荐新手，最简单）

像安装 QQ、微信一样，下载 → 安装 → 打开就能用。

**第 1 步：下载安装包**

打开 👉 [下载页面](https://github.com/icebear0828/codex-proxy/releases)，找到最新版本，根据你的电脑系统下载对应文件：

| 你的电脑系统 | 下载哪个文件 | 怎么判断系统 |
|-------------|-------------|-------------|
| Windows | `Codex Proxy Setup x.x.x.exe` | 大部分人用的就是 Windows |
| macOS（苹果电脑） | `Codex Proxy-x.x.x.dmg` | 带苹果 logo 的笔记本/台式机 |
| Linux | `Codex Proxy-x.x.x.AppImage` | 你如果用 Linux 你肯定知道 |

**第 2 步：安装**

- **Windows**：双击下载的 `.exe` 文件，一路点"下一步"直到安装完成
- **macOS**：双击 `.dmg` 文件，把图标拖到 Applications 文件夹里

**第 3 步：打开并登录**

1. 打开刚装好的「Codex Proxy」应用
2. 点击页面上的登录按钮，用你的 ChatGPT 账号登录
3. 登录成功后，代理服务就已经在运行了

**第 4 步：验证是否成功**

打开浏览器，在地址栏输入 `http://localhost:8080`，如果能看到控制面板页面，说明一切正常。

> 桌面端默认只允许本机访问（`127.0.0.1:8080`），你电脑上的 AI 客户端可以直接连。

---

### 方式二：Docker 部署（推荐服务器 / 进阶用户）

Docker 就像一个"打包好的盒子"，不需要你自己装各种依赖，一条命令就能跑起来。

**前置条件**：电脑上已安装 Docker。如果没有，先去 [docker.com](https://www.docker.com/products/docker-desktop/) 下载安装 Docker Desktop。

**第 1 步：创建项目目录**

打开终端（Windows 搜索"cmd"或"PowerShell"；macOS 搜索"终端"），输入：

```bash
mkdir codex-proxy && cd codex-proxy
```

**第 2 步：下载配置文件**

```bash
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env       # 复制一份配置模板
```

> 也可以用 `git clone` 下载完整源码，然后在项目目录中 `docker compose up -d`。

**第 3 步：启动**

```bash
docker compose up -d        # 拉取镜像并启动（后台运行）
```

**第 4 步：登录**

打开浏览器，访问 `http://localhost:8080`，用 ChatGPT 账号登录。

> 你的账号数据会保存在 `data/` 文件夹里，重启不会丢失。
>
> **其他 Docker 容器要连本服务？** 用你电脑的局域网 IP（如 `http://192.168.x.x:8080/v1`），不要用 `localhost`。

**可选：自动更新**

取消 `docker-compose.yml` 中 Watchtower 服务的注释，即可实现自动更新：

```bash
docker compose up -d        # 重新启动，Watchtower 将每小时检查更新
```

Watchtower 会自动检测新镜像版本，拉取并重启容器，无需手动操作。

---

### 方式三：源码运行（开发者 / 想改代码的用户）

直接从源代码启动，适合想自己修改或调试的人。

**前置条件**：已安装 [Node.js](https://nodejs.org/) 18 或更高版本。安装时一路默认选项即可。

**第 1 步：下载项目代码**

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
```

**第 2 步：安装依赖**

```bash
npm install                        # 安装后端依赖
cd web && npm install && cd ..     # 安装前端依赖
```

> macOS / Linux 会自动下载 curl-impersonate（用于 Chrome TLS 伪装）。
> Windows 下不可用，会自动降级为系统 curl，建议搭配本地代理或改用 Docker。

**第 3 步：启动服务**

```bash
npm run dev          # 开发模式（改了代码自动重启，适合调试）
```

或者，如果你要正式使用：

```bash
npm run build        # 先编译
npm start            # 再启动（性能更好）
```

**第 4 步：登录**

打开浏览器，访问 `http://localhost:8080`，用 ChatGPT 账号登录。

---

### ✅ 验证服务是否正常

登录成功后，打开终端，复制粘贴以下命令并回车：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

如果看到一串 AI 回复的文字流出来，恭喜你，部署成功！接下来可以去 [客户端接入](#-客户端接入-client-setup) 章节，把它连到你常用的 AI 工具上。

## 🌟 核心功能 (Features)

### 1. 🔌 全协议兼容 (Multi-Protocol API)
- 完全兼容 `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）和 Gemini 格式
- 支持 SSE 流式输出，可直接对接所有 OpenAI SDK 和客户端
- 自动完成 Chat Completions ↔ Codex Responses API 双向协议转换
- **Structured Outputs** — 支持 `response_format`（OpenAI `json_object` / `json_schema`）和 Gemini `responseMimeType`，强制 JSON 结构化输出无需提示词

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
| `gpt-5.2-codex` | `codex` | low / medium / high / xhigh | 前沿 agentic 编程模型（默认） |
| `gpt-5.2` | — | low / medium / high / xhigh | 专业工作 + 长时间代理 |
| `gpt-5.1-codex-max` | — | low / medium / high / xhigh | 扩展上下文 / 深度推理 |
| `gpt-5.1-codex` | — | low / medium / high | GPT-5.1 编程模型 |
| `gpt-5.1` | — | low / medium / high | 通用 GPT-5.1 |
| `gpt-5-codex` | — | low / medium / high | GPT-5 编程模型 |
| `gpt-5` | — | minimal / low / medium / high | 通用 GPT-5 |
| `gpt-oss-120b` | — | low / medium / high | 开源 120B 模型 |
| `gpt-oss-20b` | — | low / medium / high | 开源 20B 模型 |
| `gpt-5.1-codex-mini` | — | medium / high | 轻量快速编程模型 |
| `gpt-5-codex-mini` | — | medium / high | 轻量编程模型 |

> **模型名后缀**：在任意模型名后追加 `-fast` 启用 Fast 模式，追加 `-high`/`-low` 等切换推理等级。
> 例如：`codex-fast`、`gpt-5.2-codex-high-fast`。
>
> **注意**：`gpt-5.4`、`gpt-5.3-codex` 系列已从 free 账号移除，plus 及以上账号仍可使用。
> 模型列表由后端动态获取，会自动同步最新可用模型。

## 🔗 客户端接入 (Client Setup)

### Claude Code

在终端设置环境变量，即可让 Claude Code 通过 codex-proxy 使用 Codex 模型：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# 默认使用 gpt-5.2-codex（codex 别名），无需设置 ANTHROPIC_MODEL
# 如需切换模型或启用后缀：
# export ANTHROPIC_MODEL=codex-fast              # → gpt-5.2-codex + Fast 模式
# export ANTHROPIC_MODEL=codex-high              # → gpt-5.2-codex + high 推理
# export ANTHROPIC_MODEL=codex-high-fast         # → gpt-5.2-codex + high + Fast
# export ANTHROPIC_MODEL=gpt-5.2                 # → 通用 GPT-5.2
# export ANTHROPIC_MODEL=gpt-5.1-codex-mini      # → 轻量快速模型

claude   # 启动 Claude Code
```

> 所有 Claude Code 模型名（Opus / Sonnet / Haiku）均映射到配置的默认模型（`gpt-5.2-codex`）。
> 如需指定具体模型，通过 `ANTHROPIC_MODEL` 环境变量设置 Codex 模型名即可。

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

- 账号封禁检测：上游返回非 Cloudflare 的 403 时自动标记为 `banned` 状态
- 上游 401 token 吊销（"token has been invalidated"）自动标记过期并切换下一个账号

### [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

- 原生 function_call / tool_calls 支持（所有协议）

### [v0.7.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.7.0) - 2026-02-22

- `developer` 角色支持（OpenAI 协议）
- 数组格式 content 支持
- tool / function 消息兼容（所有协议）
- 模型响应中自动过滤 Codex Desktop 指令
<!-- CHANGELOG:END -->

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=icebear0828/codex-proxy&type=Date)](https://star-history.com/#icebear0828/codex-proxy&Date)

## 📄 许可协议 (License)

本项目采用 **非商业许可 (Non-Commercial)**：

- **允许**：个人学习、研究、自用部署
- **禁止**：任何形式的商业用途，包括但不限于出售、转售、收费代理、商业产品集成

本项目与 OpenAI 无关联。使用者需自行承担风险并遵守 OpenAI 的服务条款。

---

<div align="center">
  <sub>Built with Hono + TypeScript | Powered by Codex Desktop API</sub>
</div>
