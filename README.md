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
    <a href="#-配置说明">配置说明</a> &bull;
    <a href="#-贡献致谢">贡献致谢</a>
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
- **第三方 API Keys** — 支持 OpenAI / Anthropic / Gemini / OpenRouter / 自定义 OpenAI-compatible Provider，并按模型路由直通上游。

### 🔐 账号管理与智能轮换
- **OAuth PKCE 登录** — 浏览器一键授权，无需手动复制 Token
- **多账号轮换** — `least_used`（最少使用优先）、`round_robin`（轮询）、`sticky`（粘性）三种策略
- **Plan Routing** — 不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型
- **Token 自动续期** — JWT 到期前自动刷新，指数退避重试
- **配额被动采集** — 从上游响应头和 WebSocket rate limit 事件更新账号额度；`quota.refresh_interval_minutes` 仅控制用量快照记录，`0` 表示关闭快照定时器。
- **封禁检测** — 上游 403 自动标记 banned；401 token 吊销自动过期并切换账号
- **API Key Provider 池** — 支持通过 Dashboard 管理第三方 API Key、模型列表、导入导出和启停状态。
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
│  │OAuth/API │  │ Rust (rustls) │  │ Static + Dynamic │  │
│  │ API Keys │  │  Headers/UA   │  │  Plan Routing    │  │
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
             chatgpt.com   第三方 Provider
         /backend-api/codex  (第三方 API)
```

## 📦 可用模型

| 模型 ID | 推理等级 | 当前上下文 | 最大上下文 | 最大输出 | 输出 | 说明 |
|---------|---------|------------|------------|----------|------|------|
| `gpt-5.5` | low / medium / high / xhigh | 272,000 | 272,000 | 128,000 | 文本 | 复杂编码、研究和真实工作流旗舰模型 |
| `gpt-5.4` | low / medium / high / xhigh | 272,000 | 1,000,000 | 128,000 | 文本 | 日常编码强模型（默认） |
| `gpt-5.4-mini` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 5.4 轻量版 |
| `gpt-5.3-codex` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 5.3 编程优化模型 |
| `gpt-5.2` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文本 | 专业工作 + 长时间代理 |
| `gpt-5-codex` | low / medium / high | 400,000 | — | 128,000 | 文本 | GPT-5 编程优化模型 |
| `gpt-5-codex-mini` | medium / high | — | — | — | 文本 | 轻量 Codex / CLI 编程模型 |
| `gpt-oss-120b` | low / medium / high | 131,072 | — | — | 文本 | 开源 120B 模型 |
| `gpt-oss-20b` | low / medium / high | 131,072 | — | — | 文本 | 开源 20B 模型 |
| `gpt-image-2` | — | — | — | — | 图像 | 图像生成工具后端（通过 `image_generation` 调用） |

> **后缀**：任意 chat 模型名后追加 `-fast` 启用 Fast 模式，`-high`/`-low` 切换推理等级。例如：`gpt-5.4-fast`、`gpt-5.4-high-fast`。图像模型（`gpt-image-2`）不支持后缀。
>
> **Plan Routing**：不同 plan（free/plus/team/business）的账号自动路由到各自支持的模型，模型可用性以登录账号对应的 Codex 后端返回为准，不要按旧的 Plus-only 表理解。模型列表由后端动态获取，自动同步；只要模型出现在 Dashboard / `/v1/models/catalog` 中，就可以作为请求里的 `model` 使用。
>
> **前端模型选择 ≠ 配置文件**：Dashboard 中切换模型只影响前端展示和 API 示例中的模型名，**不会修改** `config/default.yaml` 或 `data/local.yaml` 中的 `model.default`。实际使用哪个模型取决于客户端请求中的 `model` 字段（如 Cursor、Claude Code 等自行指定），配置文件中的 `model.default` 仅在客户端未指定模型时作为兜底。
>
> **Max token 说明**：上表跟随当前 `config/models.yaml` 和 Codex runtime `/v1/models/catalog` 元数据；`—` 表示当前目录未返回该字段，不代表模型不可用。运行时从 Codex 后端拉到的模型信息会覆盖静态值，并保留 `contextWindow`、`maxContextWindow`、`maxOutputTokens`、`truncationPolicyLimit`。请求体里的 `context_window` / `max_context_window` / `truncation_policy` / `max_output_tokens` 都不是可用开关；直接转发给 Codex 原生接口会返回 `400 Unsupported parameter`。

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

> `/v1/chat/completions` 兼容路径会接受 `image_generation` 工具，避免 OpenAI 客户端因 schema 失败；但图像 payload 只有 `/v1/responses` 会稳定透出 `image_generation_call.result`。需要拿到图片字节时请使用 `/v1/responses`。

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
> 推荐模型：Opus → `gpt-5.5`，Sonnet → `gpt-5.4`，Haiku → `gpt-5.3-codex`。
>
> ⚠️ 配置不生效？请参考 **[Claude Code 配置避坑指南](.github/guides/claude-code-setup.md)**（AUTH_TOKEN 劫持、API Key 黑名单等常见问题）。

### Codex CLI

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

# 直接把 API Key 写进 config（推荐：本地单用户场景）
[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 也可以改用环境变量：把 `[model_providers.proxy_codex.http_headers]` 这两行删掉，换成 `env_key = "PROXY_API_KEY"`，然后 `export PROXY_API_KEY=your-api-key && codex`。需要避免密钥落到 config 文件（多人共享 / 开源仓库）时用这个。

### Claude Desktop

1. **开启开发者模式**：点击菜单栏 **Help** → **Troubleshooting** → **Enable Developer Mode**。
2. **配置第三方推理**：点击菜单栏新出现的 **Developer** → **Configure Third-Party Inference...**。
3. **填写配置**：
   - **Endpoint**: `http://127.0.0.1:8080`
   - **API Key**: 你的 API Key
   - **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

> 或手动修改配置文件（Windows 下路径通常在 `%APPDATA%\Claude-3p\configLibrary\` 目录下的 JSON 文件，Mac 为 `~/Library/Application Support/Claude-3p/configLibrary/`），添加如下字段：
```json
 {
   "disableDeploymentModeChooser": true,
   "inferenceProvider": "gateway",
   "inferenceGatewayBaseUrl": "http://127.0.0.1:8080",
   "inferenceGatewayApiKey": "your-api-key",
   "inferenceGatewayAuthScheme": "bearer",
   "inferenceModels": [
     "claude-opus-4-7",
     "claude-sonnet-4-6",
     "claude-haiku-4-5"
   ]
 }
```

内置 Claude 形态模型名会映射到 Codex 模型。自定义映射请写到 `data/local.yaml`，不要改 `config/models.yaml`：
```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    claude-sonnet-4-6: gpt-5.4
    claude-haiku-4-5: gpt-5.3-codex
    my-openai: openai:gpt-4o
    my-deepseek: deepseek-chat
```

alias 左边是客户端请求里填写的模型名，右边是真正发给上游的模型名。右侧可以是 Codex 模型 ID、带 provider 前缀的模型（如 `openai:gpt-4o` / `anthropic:claude-sonnet-4-5` / `gemini:gemini-2.5-pro`），也可以是已通过 `model_routing` 绑定到自定义 provider 的模型名（如 `deepseek-chat`）。别名会出现在 `/v1/models`，请求进入直连 provider 时会自动把模型名改写成映射目标。

> 💡 **排查提示 (Windows)**: 如果使用 `127.0.0.1` 时 Claude Desktop 提示 `ERR_CONNECTION_REFUSED`（而使用 `localhost` 提示 URL 格式错误），说明 Node.js 在你的系统上默认只绑定了 IPv6。请进入 Codex Proxy 控制面板的设置页面，将 **Host** 修改为 `127.0.0.1`，或在 `data/local.yaml` 中添加 `server: { host: "127.0.0.1" }` 后重启代理。
> 
> 💡 **局域网使用提示 (LAN)**: Claude Desktop 强制校验 API 地址，**只允许** `https://` 开头或 `http://127.0.0.1`。如果你将 Codex Proxy 部署在局域网另一台机器（如 `192.168.x.x`），直接填入会报错。解决方法：
> 1. **SSH 隧道 (最简单)**：在客户端机器运行 `ssh -L 8080:127.0.0.1:8080 user@192.168.x.x`，然后在 Claude 里填 `http://127.0.0.1:8080`。
> 2. **反向代理**：使用 Caddy 或 Nginx 配置局域网 HTTPS 证书。

### Codex Desktop (官方应用)

官方客户端与 CLI 共用配置文件，修改后需重启客户端生效。

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

> 💡 **为什么不用 `env_key`？** macOS / Windows 的 GUI 应用不读 shell 的 `~/.zshrc` / `.bashrc`，光 `export PROXY_API_KEY=...` 在终端里 GUI 进程根本看不到，启动会直接报 `Missing environment variable`。`http_headers` 把 Authorization 写在 config 里，重启 Codex 就能用，不用折腾 `launchctl setenv` 或 LaunchAgent。需要密钥从配置文件解耦时（共享机器 / 仓库提交）再换回 `env_key = "PROXY_API_KEY"` 走环境变量。
>
> ⚠️ 如果你是通过"登录 ChatGPT 账号"方式使用的，客户端可能会忽略此配置——只要 `[model_providers.proxy_codex]` 配上、`profiles.default.model_provider = "proxy_codex"`，新会话就会走 proxy；登录会话仍可能直接走官方上游。

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
| `model` | `default`, `default_reasoning_effort`, `default_service_tier`, `aliases`, `custom_models`, `inject_desktop_context` | 默认模型、推理配置、模型映射与自定义模型目录 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 轮换策略与限流退避 |
| `tls` | `proxy_url`, `force_http11` | TLS 代理与 HTTP 版本 |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | 用量快照、阈值配置与耗尽账号跳过 |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | Dashboard session 管理 |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama 兼容桥接 |
| `official_agent` | `enabled`, `api_key`, `app_server_url`, `auth` | 官方 Codex app-server 桥接，用于复用 Chrome/browser 插件 |

### 模型映射

`model.aliases` 用来把客户端里的模型名映射成真实上游模型，适合 Claude Desktop / Cursor / Continue 等客户端只能选择固定模型名、或你希望暴露更短别名的场景。

也可以直接在 Dashboard → Settings → **模型映射** 中添加 / 删除映射。保存后会写入 `data/local.yaml` 并热加载到后端，不需要修改 `config/default.yaml`。

```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    sonnet-local: gpt-5.4
    openai-fast: openai:gpt-4o
    deepseek-local: deepseek-chat

providers:
  custom:
    deepseek:
      api_key: "sk-..."
      base_url: "https://api.deepseek.com/v1"
      models: ["deepseek-chat"]
model_routing:
  deepseek-chat: deepseek
```

映射解析发生在 `model_routing` 和内置 Claude/Gemini 自动路由之前。映射到 Codex 模型时仍支持 `-fast` / `-high` 等后缀；映射到第三方 provider 时，直连请求会把 `model` 字段改写成右侧目标值。

如果你还需要把完全自定义的 Codex-compatible 模型 ID 加入模型目录，可在 `data/local.yaml` 中配置 `model.custom_models`。简单字符串会使用默认 text/medium 元数据；对象写法可补 display name、推理等级、上下文和输出上限：

```yaml
model:
  custom_models:
    - local-simple
    - id: local-rich
      display_name: Local Rich
      description: Local rich model
      supported_reasoning_efforts: [low, high]
      default_reasoning_effort: high
      input_modalities: [text, image]
      output_modalities: [text]
      context_window: 12345
      max_context_window: 23456
      max_output_tokens: 3456
```

### 配额轮转

`quota.skip_exhausted: true` 时，账号池会在选择账号前跳过缓存额度已经耗尽的账号；这个过滤发生在 session affinity / `preferredEntryId` 之前，所以长对话也不会强行粘到已耗尽账号上。

当前跳过条件是缓存额度里的 `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true` 或 `code_review_rate_limit.limit_reached === true`。如果只是 `used_percent` 接近 100（例如 99%）但上游还没标记 `limit_reached`，代理仍会继续使用该账号；真正打到上游 429 后，账号会进入 `rate_limited` 退避并切换到其他可用账号。secondary / code review 窗口自己的 `reset_at` 过期后会从缓存中清除，避免账号被永久跳过。

### 局域网访问

源码/容器默认配置监听 `::`（IPv6 unspecified，通常也覆盖本机访问）；Electron 启动时会传入 `127.0.0.1`，除非 `data/local.yaml` 显式覆盖。建议需要仅本机访问时写入：

```yaml
server:
  host: "127.0.0.1"
```

如需局域网内其他设备访问，在 `data/local.yaml` 中添加：

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
  # proxy_api_key: null   # null = 不配置全局密钥；已登录账号仍会生成 account-level codex-proxy-xxxx 密钥
```

首次启动如果缺少 `data/local.yaml`，程序会自动创建 `server.proxy_api_key: pwd`。当前可用密钥显示在控制面板的 API Configuration 区域。

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

### Official Agent Bridge 配置

该桥接用于连接本机官方 `codex app-server`，从而复用 Codex app 的官方 Chrome/browser 插件、审批和 app mention 能力。默认关闭，不影响现有 `/v1/*` 模型代理。

先启动官方 app-server：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

然后在 `data/local.yaml` 启用：

```yaml
server:
  proxy_api_key: "your-api-key"

official_agent:
  enabled: true
  api_key: "your-official-agent-key"
  app_server_url: ws://127.0.0.1:4500
  auth:
    type: none
```

如果 app-server 使用 capability token：

```bash
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/path/to/token
```

对应配置：

```yaml
server:
  proxy_api_key: "your-api-key"

official_agent:
  enabled: true
  api_key: "your-official-agent-key"
  app_server_url: ws://127.0.0.1:4500
  auth:
    type: capability_token
    token_file: /absolute/path/to/token
```

可用端点：

```bash
curl http://localhost:8080/official-agent/apps \
  -H "Authorization: Bearer your-official-agent-key"
```

```bash
curl -N http://localhost:8080/official-agent/threads/{threadId}/turns \
  -H "Authorization: Bearer your-official-agent-key" \
  -H "Content-Type: application/json" \
  -d '{"text":"Open localhost:8080 and inspect the dashboard","app":{"id":"chrome","name":"Chrome"}}'
```

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
<summary>点击展开主要端点列表</summary>

**协议端点**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI 格式聊天补全 |
| `/v1/responses` | POST | Codex Responses API 直通 |
| `/v1/responses/compact` | POST | Codex compact 响应代理 |
| `/v1/messages` | POST | Anthropic 格式聊天补全 |
| `/v1/models` | GET | 可用模型列表 |
| `/v1/models/catalog` | GET | Dashboard 使用的完整模型目录 |
| `/v1/models/:modelId/info` | GET | 单个模型的推理等级等详情 |
| `/v1beta/models` | GET | Gemini 格式模型列表 |
| `/v1beta/models/:modelAction` | POST | Gemini `generateContent` / `streamGenerateContent` |
| `:11434/api/chat` | POST | Ollama 兼容聊天补全（需启用 Ollama Bridge） |

**账号与认证**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | OAuth 登录入口 |
| `/auth/accounts` | GET | 账号列表（`?quota=true` / `?quota=fresh`） |
| `/auth/accounts` | POST | 添加单个账号（token 或 refreshToken） |
| `/auth/accounts/import` | POST | 批量导入账号 |
| `/auth/accounts/export` | GET | 导出账号（`?format=minimal` 精简格式） |
| `/auth/accounts/batch-delete` | POST | 批量删除账号 |
| `/auth/accounts/batch-status` | POST | 批量修改账号状态 |
| `/auth/accounts/health-check` | POST | 批量检测账号可用性 |
| `/auth/accounts/:id/refresh` | POST | 刷新并探测单个账号 |
| `/auth/accounts/:id/quota` | GET | 主动查询单个账号额度 |
| `/auth/accounts/:id/cookies` | GET/POST/DELETE | 管理账号 Cloudflare cookies |
| `/auth/quota/warnings` | GET | 当前额度预警状态 |

**第三方 API Keys**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/api-keys/catalog` | GET | 内置 Provider 与推荐模型目录 |
| `/auth/api-keys` | GET/POST | API Key 列表 / 添加 |
| `/auth/api-keys/models` | POST | 从自定义 OpenAI-compatible Provider 拉取模型 |
| `/auth/api-keys/export` | GET | 导出 API Key 配置 |
| `/auth/api-keys/import` | POST | 导入 API Key 配置 |
| `/auth/api-keys/batch-delete` | POST | 批量删除 API Key |
| `/auth/api-keys/:id` | DELETE | 删除单个 API Key |
| `/auth/api-keys/:id/label` | PATCH | 修改 API Key 标签 |
| `/auth/api-keys/:id/status` | PATCH | 启用或停用 API Key |

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
| `/admin/logs` | GET | 请求日志列表 |
| `/admin/logs/state` | GET/POST | 日志采集开关与配置 |
| `/admin/update-status` | GET | 自更新状态 |
| `/admin/check-update` | POST | 检查更新 |
| `/admin/apply-update` | POST | 执行自更新 |
| `/health` | GET | 健康检查 |

**代理池**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/proxies` | GET/POST | 代理池列表 / 添加代理 |
| `/api/proxies/:id` | PUT/DELETE | 更新 / 删除代理 |
| `/api/proxies/:id/check` | POST | 健康检查单个代理 |
| `/api/proxies/check-all` | POST | 全部代理健康检查 |
| `/api/proxies/assign` | POST | 为账号分配代理 |
| `/api/proxies/assignments` | GET | 查看账号代理分配 |
| `/api/proxies/assign-bulk` | POST | 批量分配代理 |
| `/api/proxies/assign-rule` | POST | 按规则分配代理 |
| `/api/proxies/export` | GET | 导出代理池 YAML |
| `/api/proxies/import` | POST | 导入代理池 YAML |

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
- Stream-close 事件结构化落盘到 Errors tab + 审计 log：`premature stream close` / `stream-client-abort` / `stream-client-disconnect` / `stream-error` 此前只走 `console.warn` 进 `dev-YYYY-MM-DD.log`，需要 grep 才能定位，且生产模式没有 tee；新增 `src/logs/stream-close-event.ts` 把这些事件同时写到 `data/error-log.jsonl`（Errors tab 按签名分组 + 角标计数）和 `logStore`（`/admin/logs` 审计流）。覆盖 7 个调用点：`proxy-handler.ts` 两处 client abort + 一处 `UpstreamPrematureCloseError`（带 eventCount / hadReasoning / responseId / variantHash）、`response-processor.ts` 两处（`client-write-failed` 带 writtenChunks/Bytes/lastSentEvent；`upstream-error` 带 upstreamStatus）、`responses.ts` 两处 `streamPassthrough` 内部 EOF（rid / accountEntryId / variantHash 通过 `FormatAdapter.streamTranslator` 的 `streamContext` option 由 `response-processor` 透传，其它 adapter 兼容性接收并忽略）。顺手修 `error-log.ts:readAppVersion` 在 config 未加载时崩溃（unit-test 路径会撞到），改为 try/catch 兜底回退 "unknown"。新增 `tests/unit/logs/stream-close-event.test.ts` 6 个单测覆盖 4 种 kind + 缺失 rid 兜底 + numeric upstreamStatus → audit status 透传 + direct upstream provider/path；Errors tab 展开分组时会显示 sample context。下次复现 premature close 直接看 Errors tab 按 `StreamUpstreamPrematureClose` 分组拉 rid + account + closeCode，不用再 grep dev 日志（`src/logs/stream-close-event.ts`、`src/logs/error-log.ts`、`src/routes/shared/proxy-handler.ts`、`src/routes/shared/response-processor.ts`、`src/routes/responses.ts`、`tests/unit/logs/stream-close-event.test.ts`）
- Opt-in 上游请求/响应 dumper：新增 `src/utils/debug-dump.ts`，环境变量 `CODEX_PROXY_DEBUG_DUMP=1` 启用时把每次上游请求 + 流式 chunk + 终止状态 + 错误写入 `/tmp/codex-proxy-dump-<startupMs>.jsonl`（一行一事件）；未启用时所有 hook 是 `if (debugDumpEnabled())` 守护下的纯 boolean check，零开销。在 `src/routes/shared/proxy-handler.ts` 加 1 个 hook（`request`，含 rid/tag/entryId/conv/implicitResumeActive/resumeReason/payload），在 `src/routes/shared/response-processor.ts` 加 3 个 hook（`upstream-chunk` 截断到 16KB、`stream-finish` 含 chunks/bytes/sawTerminal、`stream-error` 含 status/msg/body 截断到 4KB）。**privacy 警告**：dump 文件包含完整 request payload（含用户 prompt）和上游响应，路径在启动时打印一次提示 sensitive 性质。日常排查"账号轮换重试风暴" / "premature stream close" 等偶发错误时 opt-in 启用，问题复现后再 opt-out
- Pre-publish artifact smoke 拦在 stable 之前（#479）：`release.yml` 把 4 个平台（mac arm64 / mac x64 / win / linux）的 Pack step 从 `--publish always` 改成 `--publish never`，新增跨平台 smoke step 用 `.github/scripts/electron-smoke.sh` 启动打包好的 binary、tail 日志拿 `Server started on port N`、curl `/health`、清进程；smoke 失败直接阻塞 `gh release upload`，artifact 不会进 GitHub Release（坏的就不发）。Linux 装 `libfuse2 + xvfb` 起虚拟显示，Windows 用 `win-unpacked/*.exe` 跳过 NSIS 安装；smoke 失败时通过 `actions/upload-artifact@v4` 把日志保留 7 天给排查。新增 `tests/unit/ci/electron-smoke-script.test.ts` 6 个单测，覆盖脚本的 fail-loud 路径（缺 RUNNER_OS / RELEASE_DIR / AppImage / 不支持的 OS），保证脚本本身坏掉时不会沉默通过。CI 时间增量约 +5 分钟（Linux 最快，Windows 需研究 GHA windows-latest 的 GUI 启动行为，首次 PR 可能要回炉）（`.github/scripts/electron-smoke.sh`、`.github/workflows/release.yml`、`tests/unit/ci/electron-smoke-script.test.ts`）
- Dashboard Errors tab + Header 浮起 badge + 渲染进程错误捕获（observability，#480 PR-2）：新增 `Errors` tab（按 `name + first stack frame` 聚合，按 last_seen 降序，可展开看 sample stack；折叠后只显示一行）；Header 右侧多一个红色 pulsing badge 显示未读错误数（>99 显示 `99+`），点击跳 `#/errors`；渲染进程注册 `window.addEventListener('error')` + `unhandledrejection` 在 `main.tsx` `render()` 之前，每条事件 fetch POST `/admin/error-logs/report`（不走 IPC，复用同源 dashboardAuth）；`useErrorLogs` / `useErrorLogsCount` hook 30s 轮询；i18n 中英双语；`mark all read` 按钮调 `/admin/error-logs/seen` 推进 cursor；新增前端 web bundle +8KB gzipped（`web/src/error-capture.ts`、`web/src/pages/ErrorsPage.tsx`、`shared/hooks/use-error-logs.ts`、`web/src/App.tsx`、`web/src/components/Header.tsx`、`web/src/main.tsx`、`shared/i18n/translations.ts`、`tests/unit/web/error-capture.test.ts`、`shared/hooks/use-error-logs.test.ts`）
- 本地 uncaught error log（observability foundation，#480 PR-1）：进程级 `uncaughtException` / `unhandledRejection` 自动落盘到 `data/error-log.jsonl`，单 backup 滚动（默认 10MB → `error-log.1.jsonl`），`context` 经 `redactJson` 脱敏 token / cookie / api_key / oauth；新增 4 个 admin 端点 `/admin/error-logs`（按 `name + first stack frame` 聚合）/ `/admin/error-logs/raw`（裸 JSONL tail）/ `/admin/error-logs/count`（含 unread）/ `/admin/error-logs/seen`（推进读游标）/ `/admin/error-logs/report`（renderer / 外部 POST 上报）；`uncaughtException` 走 `setImmediate(throw)` 保留 Node 默认崩溃语义，不会静默吞掉 fatal；新增 schema 节 `observability: { local_error_log: bool=true, max_log_bytes: int=10485760 }`；前端 Errors tab + 浮起 badge 由 PR-2 跟进（`src/logs/error-log.ts`、`src/routes/admin/error-logs.ts`、`src/config-schema.ts`、`src/index.ts`、`tests/unit/logs/error-log.test.ts`、`tests/unit/routes/admin/error-logs.test.ts`）
**Changed**
- `handleProxyRequest` / `handleDirectRequest` 改为 named options object 调用契约，顺带把 private `handleNonStreaming` 的 20 个位置参数收敛成内部 options object，避免后续新增可选上下文时错位；所有 route 调用与直接 handler 测试同步迁移，并补 direct upstream route guard 锁住 adapter/raw model/format tag 传递（`src/routes/shared/proxy-handler.ts`、`src/routes/chat.ts`、`src/routes/messages.ts`、`src/routes/gemini.ts`、`src/routes/responses.ts`、`tests/unit/routes/upstream-auth-bypass.test.ts`）
- `FormatAdapter.streamTranslator` / `collectTranslator` 改为 single options object 契约，替换原先 9 个 / 6 个位置参数，避免 `tupleSchema` / `usageHint` / `onResponseMetadata` / `streamContext` 后续扩展时错位；Chat / Messages / Gemini / Responses adapter wrapper 保持下游 translator 行为不变，并补 streaming、Codex collect、direct collect 三条 guard 测试锁住 options object 传递（`src/routes/shared/proxy-handler.ts`、`src/routes/shared/response-processor.ts`、`src/routes/chat.ts`、`src/routes/messages.ts`、`src/routes/gemini.ts`、`src/routes/responses.ts`、`tests/unit/routes/shared/response-processor.test.ts`、`tests/integration/proxy-handler.test.ts`、`tests/unit/routes/shared/error-forwarding.test.ts`）
- `streamResponse` 改为 named options object 调用契约，替换原先 11 个位置参数，避免 `tupleSchema` / `onResponseId` / `usageHint` / `onResponseMetadata` / `diagnostics` 后续继续错位；Codex streaming 与 direct streaming 两个 caller 同步迁移，并补 caller-level guard 锁住 `streamContext` 的 Codex vs direct provider/path 归因（`src/routes/shared/response-processor.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/response-processor.test.ts`、`tests/integration/proxy-handler.test.ts`、`tests/unit/routes/shared/error-forwarding.test.ts`）
- request diagnostics 输出从 `proxy-handler.ts` 收敛进 `proxy-request-diagnostics.ts`，主 handler 不再直接 `console.log` / `console.warn` summary 与 large-payload warning，只负责传入已解析的 session / resume / affinity 上下文；新增 logging wrapper 行为测试和边界测试锁住 warning 输出仍由 diagnostics 模块负责（`src/routes/shared/proxy-request-diagnostics.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-request-diagnostics.test.ts`、`tests/unit/routes/shared/proxy-request-diagnostics-boundary.test.ts`）
- 非流式 collect/retry 路径从 `proxy-handler.ts` 抽到独立 `non-streaming-handler.ts`，并把 `buildCodexApi`、image generation usage 标记、Codex error prefix 清理收敛到 `proxy-handler-utils.ts`，降低主 handler 对 empty-response retry / premature-close / affinity 逻辑的耦合；新增模块边界测试、collect 阶段 `previous_response_not_found` strip-retry guard、non-stream affinity metadata guard（`src/routes/shared/non-streaming-handler.ts`、`src/routes/shared/proxy-handler-utils.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/non-streaming-handler-boundary.test.ts`、`tests/integration/proxy-handler.test.ts`）
- ...（[查看全部](./CHANGELOG.md)）
**Fixed**
- Lockfile tarball sources now point to the official npm registry instead of `registry.npmmirror.com`, and the CI package boundary guard fails if any root/web/native lockfile resolves npm packages from a non-`registry.npmjs.org` host. Root production dependency audit is also clean after non-breaking lockfile updates for `hono`, `@hono/node-server`, `undici`, `minimatch`, and `brace-expansion`; the remaining full-audit finding is the existing Electron major-version upgrade requirement (`package-lock.json`, `web/package-lock.json`, `tests/unit/ci/package-boundary.test.ts`).
- Update checker now keeps `config/default.yaml` in sync when it auto-applies a Codex Desktop appcast version, while still writing `data/version-state.json` for cold-start runtime overrides. When a matching `data/extracted-fingerprint.json` is present, the checker also carries `chromium_version` through to version state, YAML, and in-memory config so User-Agent and `sec-ch-ua` fingerprint fields do not drift. The checked-in default fingerprint is updated to Codex Desktop `26.506.31421` / build `2620` / Chromium `146` (`src/update-checker.ts`, `config/default.yaml`, `tests/unit/update-checker.test.ts`).
- Root package boundary now has a CI-enforced guard for proxy package metadata, root/workspace lockfile version sync, core npm entrypoints, local `tsx` script targets, and strict TypeScript coverage for public update scripts. This also restores the public update script entrypoints plus their extraction pattern config that `package.json` and `update-scripts-path.test.ts` already referenced, keeps them trackable by removing stale ignore rules, prevents `promote-dev-to-master` from treating missing checks as green, makes the runtime update checker fork `full-update` only when `CODEX_DESKTOP_PATH` / `CODEX_APP_PATH` points at a local Codex Desktop source, and broadens model extraction to current `gpt-*` IDs such as `gpt-5-codex` (`package-lock.json`, `.gitignore`, `.github/workflows/ci-quality.yml`, `.github/workflows/promote-dev-to-master.yml`, `.github/workflows/bump-electron.yml`, `tsconfig.scripts.json`, `config/extraction-patterns.yaml`, `src/update-checker.ts`, `scripts/build/check-update.ts`, `scripts/build/apply-update.ts`, `scripts/build/full-update.ts`, `scripts/build/types.ts`, `scripts/build/vendor-types.d.ts`, `tests/unit/ci/package-boundary.test.ts`, `tests/unit/update-checker.test.ts`, `tests/unit/update-scripts-path.test.ts`).
- Codex Desktop 指纹冷启动不再漂移：`loadMergedConfig()` 会把 `data/version-state.json` 合并进 `client.app_version/build_number`，并在匹配同版本的 `data/extracted-fingerprint.json` 可用时同步 `chromium_version`；显式 `data/local.yaml` 版本覆盖优先。`extract-fingerprint.ts` 也会优先解析 `desktopOriginator` 绑定并跳过 bundled plugin 的 `.app` 名称，避免把 `Codex Computer Use.app` 误当成 API originator（`src/config-loader.ts`、`scripts/build/extract-fingerprint.ts`、`tests/unit/config-loader.test.ts`、`tests/unit/update-scripts-originator.test.ts`、`tests/unit/update-scripts-path.test.ts`）
- 同账号 `previous_response_not_found` / `unanswered_function_call` 恢复逻辑从 `proxy-handler.ts` 拆到独立 `proxy-retry-recovery.ts`，集中处理错误分类、日志前缀、stale affinity 清理、implicit-resume restore、清 `previous_response_id` / `turnState`；主 handler 只保留 loop guard 与 continue 编排。新增 helper 行为测试和 AST/import 边界测试防止 recovery 细节回流到 orchestrator（`src/routes/shared/proxy-retry-recovery.ts`、`src/routes/shared/proxy-handler.ts`、`tests/unit/routes/shared/proxy-retry-recovery.test.ts`、`tests/unit/routes/shared/proxy-retry-recovery-boundary.test.ts`）
- ...（[查看全部](./CHANGELOG.md)）

### [v0.8.0](https://github.com/icebear0828/codex-proxy/releases/tag/v0.8.0) - 2026-02-24

**Added**
- 原生 function_call / tool_calls 支持（所有协议）
**Fixed**
- 格式错误的 chat payload 返回 400 `invalid_json` 错误
<!-- CHANGELOG:END -->

## ☕ 赞赏 & 交流

觉得有帮助？请作者喝杯咖啡，或加入微信交流群获取使用帮助。二维码见 [页面顶部](#)。

## 🙏 贡献致谢

Codex Proxy 主要由个人维护，但一路上收到了很多社区帮助。特别感谢这些通过代码、文档、修复或 PR 参与建设的贡献者：

[@SsuJojo](https://github.com/SsuJojo) · [@TutuchanXD](https://github.com/TutuchanXD) · [@kanweiwei](https://github.com/kanweiwei) · [@et2010](https://github.com/et2010) · [@d-demand-priv](https://github.com/d-demand-priv) · [@hangox](https://github.com/hangox) · [@jarvisluk](https://github.com/jarvisluk) · [@jeasonstudio](https://github.com/jeasonstudio) · [@JPClaw12](https://github.com/JPClaw12) · [@lezi-fun](https://github.com/lezi-fun) · [@lookvincent](https://github.com/lookvincent) · [@pocper1](https://github.com/pocper1) · [@woai66](https://github.com/woai66) · [@xsShuang](https://github.com/xsShuang) · [@yuwei5380](https://github.com/yuwei5380)

也感谢所有在 [Issues](https://github.com/icebear0828/codex-proxy/issues) 里提交 bug 复现、日志、兼容性反馈和功能建议的用户。这些反馈直接推动了账号轮换、代理兼容、Dashboard、Ollama Bridge、模型兼容和错误观测等能力的迭代。

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
