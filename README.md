<div align="center">

  <h1>Codex Proxy</h1>
  <h3>您的本地 Codex 编程助手中转站</h3>
  <p>将 Codex Desktop 的能力以 OpenAI / Anthropic / Gemini 标准协议对外暴露，无缝接入任意 AI 客户端。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-快速开始">快速开始</a> &bull;
    <a href="#-核心功能">核心功能</a> &bull;
    <a href="#-可用模型">可用模型</a> &bull;
    <a href="#-客户端接入">客户端接入</a> &bull;
    <a href="#-配置说明">配置说明</a>
  </p>

  <p>
    <strong>简体中文</strong> |
    <a href="./README_EN.md">English</a>
  </p>

  <br>

  <a href="https://x.com/IceBearMiner"><img src="https://img.shields.io/badge/Follow-@IceBearMiner-000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://github.com/icebear0828/codex-proxy/issues"><img src="https://img.shields.io/github/issues/icebear0828/codex-proxy?style=flat-square" alt="Issues"></a>
  <a href="#-赞赏--交流"><img src="https://img.shields.io/badge/赞赏-微信-07C160?style=flat-square&logo=wechat&logoColor=white" alt="赞赏"></a>

  <br><br>

  <table>
    <tr>
      <td align="center">
        <img src="./.github/assets/donate.png" width="180" alt="微信赞赏码"><br>
        <sub>☕ 赞赏</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/wechat.png" width="180" alt="微信交流群"><br>
        <sub>💬 微信群</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/tgimage.png" width="180" alt="Telegram 群"><br>
        <sub>💬 Telegram</sub>
      </td>
    </tr>
  </table>

</div>

---

> **声明**：本项目由个人独立开发和维护，初衷是解决自己的需求。我有自己的注册机，根本不缺 token，所以这个项目不是为了"薅"谁的资源而存在的。
>
> 我自愿开源、自愿维护。该有的功能我会加，有 bug 我也会第一时间修。但我没有义务为任何单个用户提供定制服务。
>
> 觉得代码垃圾？可以不用。觉得你写得更好？欢迎提 PR 加入贡献者。Issue 区用来反馈 bug 和建议，不是用来提需求、催更新、或指点江山的。

---

**Codex Proxy** 是一个轻量级本地中转服务，将 [Codex Desktop](https://openai.com/codex) 的 Responses API 转换为多种标准协议接口（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Gemini、Codex `/v1/responses` 直通，以及可选 Ollama `/api/chat` 兼容桥接）。通过本项目，您可以在 Cursor、Claude Code、Continue 等任何兼容上述协议的客户端中直接使用 Codex 编程模型。

只需一个 ChatGPT 账号（或接入第三方 API 中转站），配合本代理即可在本地搭建一个专属的 AI 编程助手网关。

## 🚀 快速开始

> **前置条件**：你需要一个 ChatGPT 账号（免费账号即可）。如果还没有，先去 [chat.openai.com](https://chat.openai.com) 注册一个。

### 方式一：桌面应用（推荐新手）

下载 → 安装 → 打开就能用。

**下载安装包** — 打开 [Releases 页面](https://github.com/icebear0828/codex-proxy/releases)，根据系统下载：

| 系统 | 文件 |
|------|------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

安装后打开应用，点击登录按钮用 ChatGPT 账号登录。浏览器访问 `http://localhost:8080` 即可看到控制面板。

### 方式二：Docker 部署

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
# 打开 http://localhost:8080 登录
```

> 账号数据保存在 `data/` 文件夹，重启不丢失。其他容器连本服务用宿主机 IP（如 `192.168.x.x:8080`），不要用 `localhost`。

取消 `docker-compose.yml` 中 Watchtower 的注释即可自动更新。若要在 Docker 中启用 Ollama 兼容桥接，请参考下方 [Ollama Bridge 配置](#ollama-bridge-配置)。

### 方式三：源码运行

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install                        # 安装后端依赖
cd web && npm install && cd ..     # 安装前端依赖
npm run dev                        # 开发模式（热重载）
# 或: npm run build && npm start   # 生产模式
```

> **需要 Rust 工具链**（用于编译 TLS native addon）：
> ```bash
> # 1. 安装 Rust（如果没有的话）
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> # 2. 编译 TLS addon
> cd native && npm install && npm run build && cd ..
> ```
> Docker / 桌面应用已内置编译好的 addon，无需手动编译。

打开 `http://localhost:8080` 登录。

### 验证

登录后打开控制面板 `http://localhost:8080`，在 **API Configuration** 区域找到你的 API Key，然后：

```bash
# 把 your-api-key 替换成控制面板里显示的密钥
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

看到 AI 回复的文字流即部署成功。如果返回 401，请检查 API Key 是否正确。

## 🌟 核心功能

### 🔌 全协议兼容
- 兼容 `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、Gemini 格式及 `/v1/responses`（Codex 直通）
- 内置可选 Ollama 兼容桥接，默认监听 `http://127.0.0.1:11434`
- SSE 流式输出，可直接对接所有 OpenAI / Anthropic SDK 和客户端
- 自动完成 Chat Completions / Anthropic / Gemini ↔ Codex Responses API 双向协议转换
- **Structured Outputs** — `response_format`（`json_object` / `json_schema`）和 Gemini `responseMimeType`
- **Function Calling** — 原生 `function_call` / `tool_calls` 支持（所有协议）
- 若使用自定义 API Keys，则仅兼容 OpenAI（`/v1/chat/completions`）格式。

### 🔐 账号管理与智能轮换
- **OAuth PKCE 登录** — 浏览器一键授权，无需手动复制 Token
- **多账号轮换** — `least_used`（最少使用优先）、`round_robin`（轮询）、`sticky`（粘性）三种策略
- **Plan Routing** — 不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型
- **Token 自动续期** — JWT 到期前自动刷新，指数退避重试
- **配额自动刷新** — 后台每 5 分钟拉取各账号额度，达到阈值时弹出预警横幅；额度耗尽自动跳过
- **封禁检测** — 上游 403 自动标记 banned；401 token 吊销自动过期并切换账号
- **Relay 中转站** — 支持接入第三方 API 中转站（API Key + baseUrl），自动按 `format` 决定直通或翻译
- **Web 控制面板** — 账号管理、用量统计、批量操作，中英双语；远程访问需 Dashboard 登录门

### 🌐 代理池
- **Per-Account 代理路由** — 为不同账号配置不同的上游代理
- **四种分配模式** — Global Default / Direct / Auto / 指定代理
- **健康检查** — 定时 + 手动，通过 ipify 获取出口 IP 和延迟
- **不可达自动标记** — 代理不可达时自动排除

### 🛡️ 反检测与协议伪装
- **Rust Native TLS** — 内置 reqwest + rustls native addon，TLS 指纹与真实 Codex Desktop 精确一致（依赖版本锁定）
- **完整请求头** — `originator`、`User-Agent`、`x-openai-internal-codex-residency`、`x-codex-turn-state`、`x-client-request-id` 等头按真实客户端行为发送
- **Cookie 持久化** — 自动捕获和回放 Cloudflare Cookie
- **指纹自动更新** — 轮询 Codex Desktop 更新源，自动同步 `app_version` 和 `build_number`

## 🏗️ 技术架构

```
                                Codex Proxy
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Client (Cursor / Claude Code / Continue / SDK / ...)    │
│       │                                                  │
│  POST /v1/chat/completions (OpenAI)                      │
│  POST /v1/messages         (Anthropic)                   │
│  POST /v1/responses        (Codex 直通)                  │
│  POST /gemini/*            (Gemini)                      │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐   │
│  │  Routes   │──▶│  Translation  │──▶│    Proxy     │   │
│  │  (Hono)  │   │ Multi→Codex   │   │ Native TLS   │   │
│  └──────────┘   └───────────────┘   └──────┬───────┘   │
│       ▲                                     │           │
│       │          ┌───────────────┐          │           │
│       └──────────│  Translation  │◀─────────┘           │
│                  │ Codex→Multi   │  SSE stream          │
│                  └───────────────┘                       │
│                                                          │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │   Auth   │  │  Fingerprint  │  │   Model Store    │  │
│  │ OAuth/JWT│  │ Rust (rustls) │  │ Static + Dynamic │  │
│  │  Relay   │  │  Headers/UA   │  │  Plan Routing    │  │
│  └──────────┘  └───────────────┘  └──────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │
                Rust Native Addon (napi-rs)
              reqwest 0.12.28 + rustls 0.23.36
             (TLS 指纹 = 真实 Codex Desktop)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
              chatgpt.com   Relay 中转站
         /backend-api/codex  (第三方 API)
```

## 📦 可用模型

| 模型 ID | 推理等级 | 输出 | 说明 |
|---------|---------|------|------|
| `gpt-5.5` | low / medium / high / xhigh | 文本 | 通用旗舰（Plus+） |
| `gpt-5.4` | low / medium / high / xhigh | 文本 | 最新旗舰模型（默认） |
| `gpt-5.4-mini` | low / medium / high / xhigh | 文本 | 5.4 轻量版 |
| `gpt-5.3-codex` | low / medium / high / xhigh | 文本 | 5.3 编程优化模型 |
| `gpt-5.2` | low / medium / high / xhigh | 文本 | 专业工作 + 长时间代理 |
| `gpt-5-codex` | low / medium / high | 文本 | GPT-5 编程模型 |
| `gpt-5-codex-mini` | medium / high | 文本 | 轻量编程模型 |
| `gpt-oss-120b` | low / medium / high | 文本 | 开源 120B 模型 |
| `gpt-oss-20b` | low / medium / high | 文本 | 开源 20B 模型 |
| `gpt-image-2` | — | 图像 | 图像生成后端（Plus+，通过 `image_generation` 工具调用） |

> **后缀**：任意 chat 模型名后追加 `-fast` 启用 Fast 模式，`-high`/`-low` 切换推理等级。例如：`gpt-5.4-fast`、`gpt-5.4-high-fast`。图像模型（`gpt-image-2`）不支持后缀。
>
> **Plan Routing**：不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型。模型列表由后端动态获取，自动同步。
>
> **前端模型选择 ≠ 配置文件**：Dashboard 中切换模型只影响前端展示和 API 示例中的模型名，**不会修改** `config/default.yaml` 或 `data/local.yaml` 中的 `model.default`。实际使用哪个模型取决于客户端请求中的 `model` 字段（如 Cursor、Claude Code 等自行指定），配置文件中的 `model.default` 仅在客户端未指定模型时作为兜底。

### 🖼️ 图像生成

图像生成走 `/v1/responses` 的 `image_generation` 内置工具，后端固定为 `gpt-image-2`。

**前提**：ChatGPT **Plus 及以上** 账号（free 账号上游会静默剥掉工具，模型会降级用 SVG 文本假装画图）。

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": [{"role":"user","content":"Draw a red circle on white background."}],
    "tools": [{"type":"image_generation","size":"3840x2160"}]
  }'
```

常用参数：`size`（1024×1024 / 1024×1536 / 1536×1024 / 2048×2048 / 2048×3072 / 3072×2048 / 3840×2160（4K UHD）/ `auto`，最长边 ≤ 3840 px，像素预算约 8 MP）、`output_format`（`png` / `jpeg` / `webp`）、`output_compression`（jpeg / webp 可调）、`background`（`auto` / `opaque`）、`moderation`（`auto` / `low`）、`partial_images`（0–3）。一次只能出 1 张图（`n` 固定为 1）；`model` 字段不管传什么都会被上游改写回 `gpt-image-2`。详见 [API.md](./API.md#image_generation-tool)。

事件流里 `image_generation_call` item 的 `result` 字段即 base64 编码的图像；`revised_prompt` 是上游改写后的最终提示词。

**编辑模式**（带参考图）：在 user message 的 `content` 里追加 `{"type":"input_image","image_url":"data:image/png;base64,..."}` 即可。

## 🔗 客户端接入

> 所有客户端的 API Key 均从控制面板 (`http://localhost:8080`) 获取。模型名填具体 ID（默认 `gpt-5.4`）或任意 [可用模型](#-可用模型) ID。

### Claude Code (CLI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# 切换模型: export ANTHROPIC_MODEL=gpt-5.4 / gpt-5.4-fast / gpt-5.4-mini ...
claude
```

> 控制面板的 **Anthropic SDK Setup** 卡片可一键复制环境变量（含 Opus / Sonnet / Haiku 层级模型配置）。
>
> 推荐模型：Opus → `gpt-5.4`，Sonnet → `gpt-5.3-codex`，Haiku → `gpt-5.4-mini`。
>
> ⚠️ 配置不生效？请参考 **[Claude Code 配置避坑指南](.github/guides/claude-code-setup.md)**（AUTH_TOKEN 劫持、API Key 黑名单等常见问题）。

### Codex CLI

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"
env_key = "PROXY_API_KEY"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

```bash
export PROXY_API_KEY=your-api-key
codex
```

### Claude for VSCode / JetBrains

打开 Claude 扩展设置，找到 **API Configuration**：
- **API Provider**: 选择 Anthropic
- **Base URL**: `http://localhost:8080`
- **API Key**: 你的 API Key

或在 VS Code `settings.json` 中添加：
```json
{
  "claude.apiEndpoint": "http://localhost:8080",
  "claude.apiKey": "your-api-key"
}
```

### Cursor

1. 打开 Settings → Models
2. 选择 OpenAI API
3. 设置 **Base URL**: `http://localhost:8080/v1`
4. 设置 **API Key**: 你的 API Key
5. 添加模型名 `gpt-5.4`（或其他模型 ID）

### Windsurf

1. 打开 Settings → AI Provider
2. 选择 **OpenAI Compatible**
3. **API Base URL**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. **Model**: `gpt-5.4`

### Cline (VSCode 扩展)

1. 打开 Cline 侧边栏 → 设置齿轮
2. **API Provider**: 选择 OpenAI Compatible
3. **Base URL**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. **Model ID**: `gpt-5.4`

### Continue (VSCode 扩展)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "gpt-5.4",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

### aider

```bash
aider --openai-api-base http://localhost:8080/v1 \
      --openai-api-key your-api-key \
      --model openai/gpt-5.4
```

或设置环境变量：
```bash
export OPENAI_API_BASE=http://localhost:8080/v1
export OPENAI_API_KEY=your-api-key
aider --model openai/gpt-5.4
```

### Cherry Studio

1. 设置 → 模型服务 → 添加
2. **类型**: OpenAI
3. **API 地址**: `http://localhost:8080/v1`
4. **API Key**: 你的 API Key
5. 添加模型 `gpt-5.4`

### Ollama 兼容客户端

在 Dashboard → Settings → **Ollama Bridge** 中启用后，可使用 Ollama 默认地址：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:11434` |
| API Key | 不需要，Bridge 内部会使用 Codex Proxy 的密钥访问主服务 |
| Model | `gpt-5.4`（或其他模型 ID） |

```bash
curl http://localhost:11434/api/tags

curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

> Ollama API 本身没有鉴权。默认仅监听 `127.0.0.1`，不建议暴露到公网或未信任的局域网。

### 通用 OpenAI 兼容客户端

任何支持自定义 OpenAI API Base 的客户端均可接入：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:8080/v1` |
| API Key | 控制面板获取 |
| Model | `gpt-5.4`（或其他模型 ID） |

<details>
<summary>SDK 代码示例（Python / Node.js）</summary>

**Python**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-api-key")
for chunk in client.chat.completions.create(
    model="gpt-5.4", messages=[{"role": "user", "content": "Hello!"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js**
```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "your-api-key" });
const stream = await client.chat.completions.create({
  model: "gpt-5.4", messages: [{ role: "user", content: "Hello!" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

</details>

## ⚙️ 配置说明

> **重要**：不要直接修改 `config/default.yaml`，该文件会在版本更新时被覆盖。自定义配置请通过 Dashboard 设置面板修改（自动保存到 `data/local.yaml`），或手动创建 `data/local.yaml` 写入需要覆盖的字段。`data/` 目录不受更新影响。

默认配置位于 `config/default.yaml`：

| 分类 | 关键配置 | 说明 |
|------|---------|------|
| `server` | `host`, `port`, `proxy_api_key` | 监听地址与 API 密钥 |
| `api` | `base_url`, `timeout_seconds` | 上游 API 地址与超时 |
| `client` | `app_version`, `build_number`, `chromium_version` | 模拟的 Codex Desktop 版本 |
| `model` | `default`, `default_reasoning_effort`, `inject_desktop_context` | 默认模型与推理配置 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 轮换策略与限流退避 |
| `tls` | `proxy_url`, `force_http11` | TLS 代理与 HTTP 版本 |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | 额度刷新与预警 |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | Dashboard session 管理 |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama 兼容桥接 |

### 局域网访问

默认监听 `127.0.0.1`（仅本机）。如需局域网内其他设备访问，在 `data/local.yaml` 中添加：

```yaml
server:
  host: "0.0.0.0"
```

Electron 桌面版的 `data/local.yaml` 路径：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Codex Proxy/data/local.yaml` |
| Windows | `%APPDATA%/Codex Proxy/data/local.yaml` |
| Linux | `~/.config/Codex Proxy/data/local.yaml` |

> ⚠️ 绑定 `0.0.0.0` 会将服务暴露到局域网，务必在 Dashboard → 密钥设置中配置强密钥。

### TLS 配置

```yaml
tls:
  proxy_url: null                  # null = 自动检测本地代理；填写代理 URL 指定上游代理
  force_http11: false              # HTTP/2 失败时自动降级 HTTP/1.1；true = 强制 HTTP/1.1
```

> 内置 Rust native addon（reqwest + rustls），TLS 指纹与真实 Codex Desktop 完全一致。源码运行需先编译：`cd native && npm install && npm run build`。

### API 密钥

```yaml
server:
  proxy_api_key: "pwd"    # 自定义密钥，客户端用 Bearer pwd 访问
  # proxy_api_key: null   # null = 自动生成 codex-proxy-xxxx 格式密钥
```

当前密钥始终显示在控制面板的 API Configuration 区域。

### Ollama Bridge 配置

```yaml
ollama:
  enabled: false          # true = 启动内置 Ollama 兼容监听器
  host: 127.0.0.1         # 默认仅本机可访问
  port: 11434             # Ollama 默认端口
  version: "0.18.3"       # /api/version 返回值
  disable_vision: false   # true = /api/show 不声明 vision 能力
```

支持的 Ollama 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `http://localhost:11434/api/version` | GET | Ollama 版本探测 |
| `http://localhost:11434/api/tags` | GET | 模型列表 |
| `http://localhost:11434/api/show` | POST | 模型元数据 |
| `http://localhost:11434/api/chat` | POST | 聊天补全，支持流式 NDJSON |
| `http://localhost:11434/v1/*` | 任意 | OpenAI `/v1` 直通 |

Docker 部署时，如果希望宿主机访问 `11434`：

1. 在 Dashboard 或 `data/local.yaml` 中设置 `ollama.enabled: true` 和 `ollama.host: 0.0.0.0`。
2. 取消 `docker-compose.yml` 中 `127.0.0.1:${OLLAMA_BRIDGE_PORT:-11434}:11434` 端口映射的注释。
3. 保持宿主机绑定 `127.0.0.1`，除非你明确知道自己要把无鉴权 Ollama API 暴露到网络。

浏览器 CORS 访问仅允许 `localhost`、`127.x.x.x`、`::1` 等 loopback origin；非本机网页来源不能读取桥接响应。Bridge 会为 `/v1/*` 直通请求注入已配置的 Codex Proxy API Key，因此暴露到 localhost 之外时，相当于也把主代理 API 以无鉴权方式暴露出去。

### 环境变量覆盖

| 环境变量 | 覆盖配置 |
|---------|---------|
| `PORT` | `server.port` |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `HTTPS_PROXY` | `tls.proxy_url` |
| `OLLAMA_BRIDGE_ENABLED` | `ollama.enabled` |
| `OLLAMA_BRIDGE_HOST` | `ollama.host` |
| `OLLAMA_BRIDGE_PORT` | `ollama.port` |
| `OLLAMA_BRIDGE_VERSION` | `ollama.version` |
| `OLLAMA_BRIDGE_DISABLE_VISION` | `ollama.disable_vision` |

## 📡 API 端点

<details>
<summary>点击展开完整端点列表</summary>

**协议端点**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI 格式聊天补全 |
| `/v1/responses` | POST | Codex Responses API 直通 |
| `/v1/messages` | POST | Anthropic 格式聊天补全 |
| `/v1/models` | GET | 可用模型列表 |
| `:11434/api/chat` | POST | Ollama 兼容聊天补全（需启用 Ollama Bridge） |

**账号与认证**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | OAuth 登录入口 |
| `/auth/accounts` | GET | 账号列表（`?quota=true` / `?quota=fresh`） |
| `/auth/accounts` | POST | 添加单个账号（token 或 refreshToken） |
| `/auth/accounts/import` | POST | 批量导入账号 |
| `/auth/accounts/export` | GET | 导出账号（`?format=minimal` 精简格式） |
| `/auth/accounts/relay` | POST | 添加 Relay 中转站账号 |
| `/auth/accounts/batch-delete` | POST | 批量删除账号 |
| `/auth/accounts/batch-status` | POST | 批量修改账号状态 |

**账号导入导出示例**

```bash
# 导出所有账号（完整格式，含 token）
curl -s http://localhost:8080/auth/accounts/export \
  -H "Authorization: Bearer your-api-key" > backup.json

# 导出精简格式（仅 refreshToken + label，适合分享）
curl -s "http://localhost:8080/auth/accounts/export?format=minimal" \
  -H "Authorization: Bearer your-api-key" > backup-minimal.json

# 批量导入（支持 token、refreshToken，或两者同时传）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "accounts": [
      { "token": "eyJhbGciOi..." },
      { "refreshToken": "v1.abc..." },
      { "refreshToken": "v1.def...", "label": "备用账号" }
    ]
  }'
# 返回: { "added": 2, "updated": 1, "failed": 0, "errors": [] }

# 备份恢复一键操作（导出后直接导入到另一个实例）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d @backup.json
```

**管理接口**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/rotation-settings` | GET/POST | 轮换策略配置 |
| `/admin/quota-settings` | GET/POST | 额度刷新与预警配置 |
| `/admin/ollama-settings` | GET/POST | Ollama Bridge 配置 |
| `/admin/ollama-status` | GET | Ollama Bridge 运行状态 |
| `/admin/refresh-models` | POST | 手动刷新模型列表 |
| `/admin/usage-stats/summary` | GET | 用量统计汇总 |
| `/admin/usage-stats/history` | GET | 用量时间序列 |
| `/health` | GET | 健康检查 |

**代理池**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/proxies` | GET/POST | 代理池列表 / 添加代理 |
| `/api/proxies/:id` | PUT/DELETE | 更新 / 删除代理 |
| `/api/proxies/:id/check` | POST | 健康检查单个代理 |
| `/api/proxies/check-all` | POST | 全部代理健康检查 |
| `/api/proxies/assign` | POST | 为账号分配代理 |

</details>

## 📋 系统要求

- **Node.js** 18+（推荐 20+）
- **Rust** — 源码运行需 Rust 工具链（编译 TLS native addon）；Docker / 桌面应用已内置
- **ChatGPT 账号** — 免费账号即可
- **Docker**（可选）

## ⚠️ 注意事项

- Codex API 为**流式输出专用**，`stream: false` 时代理内部流式收集后返回完整 JSON
- 本项目依赖 Codex Desktop 的公开接口，上游版本更新时会自动检测并更新指纹
- Windows 下 native TLS addon 需 Rust 工具链编译；Docker 部署已预编译，无需额外配置

## 📝 最近更新

> 完整更新日志请查看 [CHANGELOG.md](./CHANGELOG.md)，以下内容由 CI 自动同步。

<!-- CHANGELOG:START -->
### [Unreleased]

**Added**
- `config/models.yaml`: `gpt-5.5` (Plus-only general-purpose chat) and `gpt-image-2` (Plus-only image-generation backend) entered the static catalog
- `CodexModelInfo.outputModalities` optional field on the model catalog interface to flag image-gen models apart from chat models (`src/models/model-store.ts`, `BackendModelEntry.output_modalities` also added for backend passthrough). `/v1/models/catalog` defaults missing values to `["text"]` so API output matches the documented contract.
- README 新增图像生成小节 + 模型表 Output 列；`API.md` / `API_CN.md` 补 `image_generation` 工具参数矩阵、事件流、编辑模式文档
- Dashboard: new Logs tab to inspect ingress/egress requests, with enable/pause controls, filters, search, and details panel.
- 控制台新增日志页面：支持启用/暂停、方向筛选、搜索与详情查看，便于排查请求流向。
- ...（[查看全部](./CHANGELOG.md)）
**Changed**
- Default model switched from `gpt-5.3-codex` → `gpt-5.4` (`config/default.yaml`, `config/models.yaml.isDefault`, Zod schema default in `src/config-schema.ts`). Removed the `codex` alias — clients must use full model IDs. Sonnet mapping in Anthropic preset/README 推荐表保持 `gpt-5.3-codex` 不变（编程场景更贴位）
- Static `isDefault` and `outputModalities` on `config/models.yaml` entries now survive the backend dynamic fetch merge (previously the spread of normalized `undefined`/`false` silently clobbered YAML-declared values)
- Dashboard session 默认 TTL 从 1 小时延长至 24 小时
**Fixed**
- 无可用账号时不再执行无意义的重试，直接返回描述性错误信息（含各状态账号计数：rate-limited / expired / banned / disabled）(#362)
- API Key 路由（OpenAI/Anthropic/Gemini）上游返回错误时，透传原始 JSON 响应体，而非包装为代理自有格式；Codex 账号路由仍使用代理格式 (#367)
- `least_used` 策略不再将 `window_reset_at = null` 的新账号（从未收到限速响应头）视为 Infinity 而永久排在已有窗口账号之后；现在两者都进入 `request_count` 比较，新账号（0 请求）可正确轮转到，`__cf_bm` cookie 也能正常写入 (#342)
- 默认不再发送 `reasoning.effort`：移除 `modelInfo.defaultReasoningEffort` 自动兜底，`default_reasoning_effort` 默认改为 `null`，彻底消除简单对话触发 medium 推理导致的 token 暴涨；Dashboard 新增 "Disabled (no reasoning)" 选项，用户可按需开启
- 上游 401 时立即触发 RT→AT 刷新，而非等待定时器（修复 token 被提前作废后账号一直显示 expired 的问题）
- ...（[查看全部](./CHANGELOG.md)）

### [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

**Added**
- 原生 function_call / tool_calls 支持（所有协议）
**Fixed**
- 格式错误的 chat payload 返回 400 `invalid_json` 错误
<!-- CHANGELOG:END -->

## ☕ 赞赏 & 交流

觉得有帮助？请作者喝杯咖啡，或加入微信交流群获取使用帮助。二维码见 [页面顶部](#)。

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=icebear0828/codex-proxy&type=Date)](https://star-history.com/#icebear0828/codex-proxy&Date)

## 📄 许可协议

本项目采用 **非商业许可 (Non-Commercial)**：

- **允许**：个人学习、研究、自用部署
- **禁止**：任何形式的商业用途，包括但不限于出售、转售、收费代理、商业产品集成

本项目与 OpenAI 无关联。使用者需自行承担风险并遵守 OpenAI 的服务条款。

---

<div align="center">
  <sub>Built with Hono + TypeScript + Rust | Powered by Codex Desktop API</sub>
</div>
