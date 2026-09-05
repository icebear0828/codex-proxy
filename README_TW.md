<div align="center">

  <h1>Codex Proxy</h1>
  <h3>您的本地 Codex 程式設計助手中轉站</h3>
  <p>將 Codex Desktop 的能力以 OpenAI / Anthropic / Gemini 標準協議對外暴露，無縫接入任意 AI 客戶端。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-快速開始">快速開始</a> &bull;
    <a href="#-核心功能">核心功能</a> &bull;
    <a href="#-可用模型">可用模型</a> &bull;
    <a href="#-客戶端接入">客戶端接入</a> &bull;
    <a href="#-配置說明">配置說明</a> &bull;
    <a href="./API_TW.md">API 文件</a> &bull;
    <a href="#-貢獻致謝">貢獻致謝</a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> |
    <strong>繁體中文 (台灣)</strong> |
    <a href="./README_HK.md">繁體中文 (香港)</a> |
    <a href="./README_EN.md">English</a> |
    <a href="./README_JA.md">日本語</a>
  </p>

  <br>

  <a href="https://x.com/IceBearMiner"><img src="https://img.shields.io/badge/Follow-@IceBearMiner-000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://github.com/icebear0828/codex-proxy/issues"><img src="https://img.shields.io/github/issues/icebear0828/codex-proxy?style=flat-square" alt="Issues"></a>
  <a href="#-贊賞--交流"><img src="https://img.shields.io/badge/贊賞-微信-07C160?style=flat-square&logo=wechat&logoColor=white" alt="贊賞"></a>

  <br><br>

  <table>
    <tr>
      <td align="center">
        <img src="./.github/assets/donate.png" width="180" alt="微信贊賞碼"><br>
        <sub>☕ 贊賞</sub>
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

**Codex Proxy** 是一個輕量級本地中轉服務，將 [Codex Desktop](https://openai.com/codex) 的 Responses API 轉換為多種標準協議介面（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Gemini、Codex `/v1/responses` 直通，以及可選 Ollama `/api/chat` 相容橋接）。透過本專案，您可以在 Cursor、Claude Code、Continue、Pi 等任何相容上述協議的客戶端中直接使用 Codex 程式設計模型。

只需一個 ChatGPT 帳號（或接入第三方 API 中轉站），配合本代理即可在本地搭建一個專屬的 AI 程式設計助手閘道。

## 🚀 快速開始

> **前置條件**：您需要一個 ChatGPT 帳號（免費帳號即可）。如果還沒有，請先前往 [chat.openai.com](https://chat.openai.com) 註冊。

<details>
<summary><h3>方式一：桌面應用程式（推薦新手）</h3></summary>

下載 → 安裝 → 打開即可使用。

**下載安裝套件** — 開啟 [Releases 頁面](https://github.com/icebear0828/codex-proxy/releases)，根據系統下載：

| 系統 | 檔案 |
|------|------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

安裝後打開應用程式，點擊登入按鈕使用 ChatGPT 帳號登入。瀏覽器造訪 `http://localhost:8080` 即可查看控制面板。

</details>

<details>
<summary><h3>方式二：No-Node Lite（瀏覽器／伺服器版，適合進階使用者）</h3></summary>

如果您已安裝 Node.js，或需要在伺服器、WSL 等沒有桌面環境的機器上執行 Codex Proxy，
可以使用 No-Node Lite。它使用與 Electron 版相同的後端與控制面板，但不內建 Node.js，
因此套件更小，也方便您自行管理執行環境；上方的 Electron 安裝套件不受影響。

請從 Releases 下載 `codex-proxy-<version>-no-node-lite-all-platforms.tar.xz`，解壓縮後在套件根目錄執行：

```bash
# Windows：雙擊 codex-proxy.exe
# macOS/Linux：
./codex-proxy.sh
```

此版本需要 Node.js 20 或更新版本。Windows 會優先使用 WebView2；如果無法使用，則啟動服務並
以系統瀏覽器開啟實際的服務網址。`--mode=server` 只啟動服務，`--mode=browser` 強制使用瀏覽器，
`--mode=webview2` 強制使用 WebView2。指定 `--portable`（`-p`）可將設定與資料保存於套件目錄內。

Linux x64 Lite 同時包含 glibc 與 musl TLS native addon，可用於常見 Linux 發行版及 Alpine Linux；
目前不包含 Linux ARM 等其他 native 架構。

</details>

<details>
<summary><h3>方式三：Docker 部署</h3></summary>

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
# 打開 http://localhost:8080 登入
```

> 帳號數據保存在 `data/` 資料夾，重啟不遺失。其他容器連線本服務請用主機 IP（如 `192.168.x.x:8080`），不要用 `localhost`。

取消 `docker-compose.yml` 中 Watchtower 的註釋即可自動更新。若要在 Docker 中啟用 Ollama 相容橋接，請參考下方 [Ollama Bridge 配置](#ollama-bridge-配置)。

</details>

<details>
<summary><h3>方式四：原始碼運行</h3></summary>

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install                        # 安裝後端依賴
cd web && npm install && cd ..     # 安裝前端依賴
npm run dev                        # 開發模式（熱重載）
# 或: npm run build && npm start   # 生產模式
```

> **需要 Rust 工具鏈**（用於編譯 TLS native addon）：
> ```bash
> # 1. 安裝 Rust（若尚未安裝）
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> # 2. 編譯 TLS addon
> cd native && npm install && npm run build && cd ..
> ```
> Docker / 桌面應用程式已內建編譯好的 addon，無需手動編譯。

打開 `http://localhost:8080` 登入。

</details>

### 驗證

登入後打開控制面板 `http://localhost:8080`，在 **API Configuration** 區域找到您的 API Key，然後：

```bash
# 將 your-api-key 替換為控制面板中顯示的金鑰
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

看到 AI 回覆的文字串流即部署成功。若回傳 401，請檢查 API Key 是否正確。

## 🌟 核心功能

### 🔌 全協議相容
- 相容 `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、Gemini 格式及 `/v1/responses`（Codex 直通）
- 內建可選 Ollama 相容橋接，預設監聽 `http://127.0.0.1:11434`
- SSE 串流輸出，可直接對接所有 OpenAI / Anthropic SDK 和客戶端
- 自動完成 Chat Completions / Anthropic / Gemini ↔ Codex Responses API 雙向協議轉換
- **Structured Outputs** — `response_format`（`json_object` / `json_schema`）與 Gemini `responseMimeType`
- **Function Calling** — 原生 `function_call` / `tool_calls` 支援（所有協議）
- **第三方 API Keys** — 支援 OpenAI / Anthropic / Gemini / OpenRouter / 自訂 OpenAI 相容 Provider，並依模型路由直通上游。
- 📖 完整介面定義與協議說明請查閱 **[API 文件](./API_TW.md)**。

### 🔐 帳號管理與智慧輪換
- **OAuth PKCE 登入** — 瀏覽器一鍵授權，無需手動複製 Token
- **多帳號輪換** — `least_used`（最少使用優先）、`round_robin`（輪詢）、`sticky`（粘性）三種策略
- **Plan Routing** — 不同方案（free/plus/team/business）的帳號自動路由至各自支援的模型
- **Token 自動續期** — JWT 到期前自動更新，指數退避重試
- **配額採集** — 預設從上游回應標頭與 WebSocket rate limit 事件被動更新帳號額度；手動查詢單帳號額度時會呼叫 `/backend-api/wham/usage`，並將 `remaining_percent = 100 - used_percent` 寫入快取。
- **封禁偵測** — 上游 403 自動標記 banned；401 token 撤銷自動過期並切換帳號
- **API Key Provider 池** — 支援透過 Dashboard 管理第三方 API Key、模型清單、匯入匯出與啟停狀態。
- **Web 控制面板** — 帳號管理、用量統計、批次操作，支援繁簡英多語言；遠端造訪需 Dashboard 登入防護

### 🌐 代理池
- **個別帳號代理路由** — 為不同帳號設定不同的上游代理伺服器
- **四種分配模式** — Global Default / Direct / Auto / 指定代理
- **健康檢查** — 定時 + 手動，透過 ipify 獲取出網 IP 與延遲
- **不可達自動排除** — 代理不可用時自動跳過

### 🛡️ 反偵測與協議偽裝
- **Rust Native TLS** — 內建 reqwest + rustls native addon，TLS 指紋與真實 Codex 客戶端精確一致（依賴版本鎖定）
- **客戶端 Profile 預設** — 支援 `codex_cli`（預設，官方 CLI 純淨終端標頭）、`codex_desktop`（Desktop 完整標頭）、`opencode`、`pi` 與 `custom`，CLI 模式下自動剔除瀏覽器特有標頭（`sec-ch-ua` 等）
- **個別帳號 Device ID 隔離** — 為每個帳號獨立衍生並持久化專屬的 `x-codex-installation-id`，徹底杜絕多帳號共享同一設備指紋
- **完整請求標頭仿真** — `originator`、`User-Agent`、`x-openai-internal-codex-residency`、`x-codex-turn-state`、`x-client-request-id` 等標頭按選定 profile 真實模擬發送
- **Cookie 持久化** — 自動擷取與重放 Cloudflare Cookie
- **指紋自動更新** — 輪詢 Codex 更新來源，自動同步 `app_version` 與 `build_number`

<details>
<summary><h2>🏗️ 技術架構</h2></summary>

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
             (TLS 指紋 = 真實 Codex Desktop)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
             chatgpt.com   第三方 Provider
         /backend-api/codex  (第三方 API)
```

</details>

<details>
<summary><h2>📦 可用模型</h2></summary>

| 模型 ID | 推理等級 | 當前上下文 | 最大上下文 | 最大輸出 | 輸出 | 說明 |
|---------|---------|------------|------------|----------|------|------|
| `gpt-5.6-sol` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | 文字 | GPT-5.6 旗艦：複雜推理與程式設計（預設；`gpt-5.6` 為其別名） |
| `gpt-5.6-terra` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | 文字 | GPT-5.6 智慧與成本平衡 |
| `gpt-5.6-luna` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | 文字 | GPT-5.6 高性價比 / 高吞吐 |
| `gpt-5.5` | low / medium / high / xhigh | 272,000 | 272,000 | 128,000 | 文字 | 複雜程式設計、研究與真實工作流程 |
| `gpt-5.4` | low / medium / high / xhigh | 272,000 | 1,000,000 | 128,000 | 文字 | 日常程式設計強模型 |
| `gpt-5.4-mini` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文字 | 5.4 輕量版 |
| `gpt-5.3-codex` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文字 | 5.3 程式設計最佳化模型 |
| `gpt-5.2` | low / medium / high / xhigh | 400,000 | — | 128,000 | 文字 | 專業工作 + 長時間 Agent 代理 |
| `gpt-5-codex` | low / medium / high | 400,000 | — | 128,000 | 文字 | GPT-5 程式設計最佳化模型 |
| `gpt-5-codex-mini` | medium / high | — | — | — | 文字 | 輕量 Codex / CLI 程式設計模型 |
| `gpt-oss-120b` | low / medium / high | 131,072 | — | — | 文字 | 開源 120B 模型 |
| `gpt-oss-20b` | low / medium / high | 131,072 | — | — | 文字 | 開源 20B 模型 |
| `gpt-image-2` | — | — | — | — | 圖像 | 圖像生成工具後端（透過 `image_generation` 呼叫） |

> **後綴**：任意 chat 模型名稱後追加 `-fast` 啟用 Fast 模式，`-high`/`-low`/`-max`/`-ultra` 切換推理等級。例如：`gpt-5.6-sol-fast`、`gpt-5.6-sol-high-fast`、`gpt-5.6-sol-max`、`gpt-5.6-sol-ultra`。圖像模型（`gpt-image-2`）不支援後綴。
>
> **Plan Routing**：不同方案（free/plus/team/business）的帳號自動路由至各自支援的模型，模型可用性以登入帳號對應的 Codex 後端回傳為準。模型清單由後端動態取得並自動同步；只要模型出現在 Dashboard / `/v1/models/catalog` 中，即可作為請求裡的 `model` 使用。
>
> **前端模型選擇 ≠ 設定檔**：Dashboard 中切換模型僅影響前端展示與 API 範例中的模型名稱，**不會修改** `config/default.yaml` 或 `data/local.yaml` 中的 `model.default`。實際使用哪個模型取決於客戶端請求中的 `model` 欄位，設定檔中的 `model.default` 僅在客戶端未指定模型時作為備援。
>
> **Max token 說明**：上表跟隨當前 `config/models.yaml` 與 Codex runtime `/v1/models/catalog` 中繼資料；`—` 表示當前目錄未回傳該欄位，不代表模型不可用。

### 🖼️ 圖像生成

圖像生成走 `/v1/responses` 的 `image_generation` 內建工具，後端固定為 `gpt-image-2`。

**前提**：ChatGPT **Plus 及以上** 帳號（free 帳號上游會靜默剝除工具，模型會降級用 SVG 文字替代繪圖）。

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "stream": true,
    "input": [{"role":"user","content":"Draw a red circle on white background."}],
    "tools": [{"type":"image_generation","size":"3840x2160"}]
  }'
```

常用參數：`size`（可請求 1024×1024 / 1024×1536 / 1536×1024 / 2048×2048 / 2048×3072 / 3072×2048 / 3840×2160 / `auto`）、`output_format`（`png` / `jpeg` / `webp`）、`output_compression`（jpeg / webp 可調）、`background`（`auto` / `opaque`）、`moderation`（`auto` / `low`）、`partial_images`（0–3）。一次只能產生 1 張圖（`n` 固定為 1）；`model` 欄位無論傳入什麼都會被上游改寫為圖像工具的實際模型（當前回應回顯為 `gpt-image-2-codex`）。詳見 [API_TW.md](./API_TW.md#image_generation-工具)。

> **`size` 不是固定像素保證。** Proxy 會保留並發送客戶端填寫的值，但當前上游會把 `2048x2048`、`2K`、`4K` 等請求正規化為 `size: "auto"`，再自行決定實際尺寸。因此不能依靠該欄位獲得原生精確的 2K/4K 輸出；請以結果 item 的 `size` 或解碼後圖片像素為準。

事件串流中 `image_generation_call` item 的 `result` 欄位即 base64 編碼的圖像；`revised_prompt` 是上游改寫後的最終提示詞。

**編輯模式**（附帶參考圖）：在 user message 的 `content` 內加入 `{"type":"input_image","image_url":"data:image/png;base64,..."}` 即可。

> `/v1/chat/completions` 相容路徑會接受 `image_generation` 工具，避免 OpenAI 客戶端因 schema 失敗；但圖像 payload 只有 `/v1/responses` 與 `POST /v1/images/generations` 會穩定透出圖片數據。

</details>

## 🔗 客戶端接入

> 所有客戶端的 API Key 均從控制面板 (`http://localhost:8080`) 取得。模型名稱填具體 ID（預設 `gpt-5.6-sol`）或任意 [可用模型](#-可用模型) ID。

<details>
<summary><h3>Claude Code (CLI)</h3></summary>

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# 切換模型: export ANTHROPIC_MODEL=gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.6-sol-fast ...
claude
```

> 控制面板的 **Anthropic SDK Setup** 卡片可一鍵複製環境變數（含 Opus / Sonnet / Haiku 層級模型設定）。
>
> 推薦模型：Opus → `gpt-5.6-sol`，Sonnet → `gpt-5.6-terra`，Haiku → `gpt-5.6-luna`。
>
> ⚠️ 設定未生效？請參考 **[Claude Code 配置避坑指南](.github/guides/claude-code-setup.md)**（AUTH_TOKEN 劫持、API Key 黑名單等常見問題）。

</details>

<details>
<summary><h3>Codex CLI</h3></summary>

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

# 直接把 API Key 寫入 config（推薦：本地單用戶場景）
[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.6-sol"
model_provider = "proxy_codex"
```

> 💡 亦可改用環境變數：將 `[model_providers.proxy_codex.http_headers]` 兩行替換為 `env_key = "PROXY_API_KEY"`，然後 `export PROXY_API_KEY=your-api-key && codex`。

</details>

<details>
<summary><h3>Claude Desktop</h3></summary>

1. **開啟開發者模式**：點擊選單列 **Help** → **Troubleshooting** → **Enable Developer Mode**。
2. **設定第三方推理**：點擊選單列新出現的 **Developer** → **Configure Third-Party Inference...**。
3. **填寫設定**：
   - **Endpoint**: `http://127.0.0.1:8080`
   - **API Key**: 您的 API Key
   - **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

> 或手動修改設定檔（Windows 下路徑通常在 `%APPDATA%\Claude-3p\configLibrary\` 目錄下的 JSON 檔案，Mac 為 `~/Library/Application Support/Claude-3p/configLibrary/`），加入如下欄位：
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

內建 Claude 形態模型名會映射至 Codex 模型。自訂映射請寫入 `data/local.yaml`，不要修改 `config/models.yaml`：
```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.6-sol
    claude-sonnet-4-6: gpt-5.6-terra
    claude-haiku-4-5: gpt-5.6-luna
    my-openai: openai:gpt-4o
    my-deepseek: deepseek-chat
```

</details>

<details>
<summary><h3>Cursor</h3></summary>

1. 打開 Settings → Models
2. 選擇 OpenAI API
3. 設定 **Base URL**: `http://localhost:8080/v1`
4. 設定 **API Key**: 您的 API Key
5. 新增模型名稱 `gpt-5.6-sol`（或其他模型 ID）

</details>

<details>
<summary><h3>Windsurf</h3></summary>

1. 打開 Settings → AI Provider
2. 選擇 **OpenAI Compatible**
3. **API Base URL**: `http://localhost:8080/v1`
4. **API Key**: 您的 API Key
5. **Model**: `gpt-5.6-sol`

</details>

<details>
<summary><h3>Cline (VSCode 擴充套件)</h3></summary>

1. 打開 Cline 側邊欄 → 設定齒輪
2. **API Provider**: 選擇 OpenAI Compatible
3. **Base URL**: `http://localhost:8080/v1`
4. **API Key**: 您的 API Key
5. **Model ID**: `gpt-5.6-sol`

</details>

<details>
<summary><h3>Continue (VSCode 擴充套件)</h3></summary>

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "gpt-5.6-sol",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

</details>

<details>
<summary><h3>aider</h3></summary>

```bash
aider --openai-api-base http://localhost:8080/v1 \
      --openai-api-key your-api-key \
      --model openai/gpt-5.6-sol
```

</details>

<details>
<summary><h3>Ollama 相容客戶端</h3></summary>

在 Dashboard → Settings → **Ollama Bridge** 中啟用後，可使用 Ollama 預設位址：

| 設定項目 | 值 |
|--------|-----|
| Base URL | `http://localhost:11434` |
| API Key | 不需要，Bridge 內部會使用 Codex Proxy 的金鑰存取主服務 |
| Model | `gpt-5.6-sol`（或其他模型 ID） |

```bash
curl http://localhost:11434/api/tags

curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

> Ollama API 本身沒有鑑權。預設僅監聽 `127.0.0.1`，不建議暴露至公網或未受信任的區域網路。

</details>

<details>
<summary><h3>通用 OpenAI 相容客戶端</h3></summary>

任何支援自訂 OpenAI API Base 的客戶端均可接入：

| 設定項目 | 值 |
|--------|-----|
| Base URL | `http://localhost:8080/v1` |
| API Key | 控制面板取得 |
| Model | `gpt-5.6-sol`（或其他模型 ID） |

**Python**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-api-key")
for chunk in client.chat.completions.create(
    model="gpt-5.6-sol", messages=[{"role": "user", "content": "Hello!"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js**
```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "your-api-key" });
const stream = await client.chat.completions.create({
  model: "gpt-5.6-sol", messages: [{ role: "user", content: "Hello!" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

</details>

<details>
<summary><h2>⚙️ 配置說明</h2></summary>

> **重要**：請勿直接修改 `config/default.yaml`，該檔案會在版本更新時被覆蓋。自訂設定請透過 Dashboard 設定面板修改（自動儲存至 `data/local.yaml`），或手動建立 `data/local.yaml` 寫入需覆蓋的欄位。`data/` 目錄不受更新影響。

預設設定位於 `config/default.yaml`：

| 分類 | 關鍵設定 | 說明 |
|------|---------|------|
| `server` | `host`, `port`, `proxy_api_key` | 監聽位址與 API 金鑰 |
| `api` | `base_url`, `timeout_seconds` | 上游 API 位址與逾時 |
| `client` | `profile`, `originator`, `app_version`, `build_number`, `platform`, `arch`, `chromium_version` | 客戶端指紋預設（`codex_cli` / `codex_desktop` / `opencode` / `pi` / `custom`）及版本參數 |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier`, `aliases`, `custom_models`, `inject_desktop_context` | 預設模型、推理設定、模型映射與自訂模型目錄 |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | 輪換策略與限流退避 |
| `tls` | `proxy_url`, `force_http11` | TLS 代理與 HTTP 版本 |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | 用量快照、閾值設定與耗盡帳號跳過 |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | Dashboard session 管理 |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama 相容橋接 |
| `official_agent` | `enabled`, `api_key`, `app_server_url`, `auth` | 官方 Codex app-server 橋接，用於復用 Chrome/browser 外掛程式 |

### 區域網路造訪

原始碼預設設定僅監聽 `127.0.0.1`；Electron 亦會傳入 `127.0.0.1`，除非 `data/local.yaml` 明確覆蓋。如需區域網路內其他設備造訪，可在 `data/local.yaml` 中設定：

```yaml
server:
  host: "0.0.0.0"
```

> ⚠️ 綁定 `0.0.0.0` 會將服務暴露至區域網路，務必在 Dashboard → 金鑰設定中設定強金鑰。

</details>

<details>
<summary><h2>📡 API 端點</h2></summary>

完整端點清單與詳細參數請參閱 **[API 文件 (API_TW.md)](./API_TW.md)**。

| 端點 | 方法 | 說明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI 格式聊天補全 |
| `/v1/messages` | POST | Anthropic 格式聊天補全 |
| `/v1/responses` | POST / WS | Codex Responses API 直通與 WebSocket 傳輸 |
| `/v1/images/generations` | POST | OpenAI 相容圖片生成 |
| `/v1/embeddings` | POST | OpenAI 相容向量嵌入 |
| `/v1/models` | GET | 可用模型清單 |
| `/v1/sub-key/info` | GET | 子金鑰配額與用量自查 |
| `/auth/accounts` | GET/POST | 帳號清單與新增 |
| `/auth/api-keys` | GET/POST | 第三方 Provider API Key 管理 |
| `/admin/general-settings` | GET/POST | 伺服器與代理通用設定 |
| `/health` | GET | 服務健康檢查探針 |

</details>

## 📋 系統要求

- **Node.js** 18+（推薦 20+）
- **Rust** — 原始碼運行需 Rust 工具鏈（編譯 TLS native addon）；Docker / 桌面應用程式已內建
- **ChatGPT 帳號** — 免費帳號即可
- **Docker**（可選）

## ⚠️ 注意事項

- Codex API 為**串流輸出專用**，`stream: false` 時代理內部串流收集後回傳完整 JSON
- 本專案依賴 Codex Desktop 的公開介面，上游版本更新時會自動偵測並更新指紋
- Windows 下 native TLS addon 需 Rust 工具鏈編譯；Docker 部署已預編譯，無需額外配置

## 📝 最近更新

完整更新日誌請查看 [CHANGELOG.md](./CHANGELOG.md)。

## ☕ 贊賞 & 交流

覺得有幫助？請作者喝杯咖啡，或加入交流群獲取使用協助。QR Code 見 [頁面頂部](#)。

## 🙏 貢獻致謝

Codex Proxy 最初只是一個個人自用專案，一路走來收穫了超乎預期的關注與支持。

特別感謝所有透過程式碼、文件、修復或 PR 參與建設的貢獻者：

[@SsuJojo](https://github.com/SsuJojo) · [@TutuchanXD](https://github.com/TutuchanXD) · [@kanweiwei](https://github.com/kanweiwei) · [@et2010](https://github.com/et2010) · [@d-demand-priv](https://github.com/d-demand-priv) · [@hangox](https://github.com/hangox) · [@jarvisluk](https://github.com/jarvisluk) · [@jeasonstudio](https://github.com/jeasonstudio) · [@JPClaw12](https://github.com/JPClaw12) · [@lezi-fun](https://github.com/lezi-fun) · [@lookvincent](https://github.com/lookvincent) · [@pocper1](https://github.com/pocper1) · [@woai66](https://github.com/woai66) · [@xsShuang](https://github.com/xsShuang) · [@yuwei5380](https://github.com/yuwei5380) · [@aeltorio](https://github.com/aeltorio) · [@williamjameshandley](https://github.com/williamjameshandley) · [@FlavienKlr](https://github.com/FlavienKlr) · [@zyycn](https://github.com/zyycn)

感謝所有在 [Issues](https://github.com/icebear0828/codex-proxy/issues) 裡提交 bug 重現、日誌、相容性回饋和功能建議的使用者。

**更要由衷感謝所有默默使用、關注和支援本專案的開發者朋友們。正是你們的認可與喜愛，讓我一直堅持維護和迭代到現在。很高興有這麼多人喜歡 Codex Proxy！** ❤️

## ⭐ Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=icebear0828/codex-proxy&type=Date)](https://star-history.dera.page/#icebear0828/codex-proxy&Date)

## 📄 許可協議

本專案採用 **非商業許可 (Non-Commercial)**：

- **允許**：個人學習、研究、自用部署
- **禁止**：任何形式的商業用途，包括但不限於出售、轉售、收費代理、商業產品整合

本專案與 OpenAI 無關聯。使用者需自行承擔風險並遵守 OpenAI 的服務條款。

---

<div align="center">
  <sub>Built with Hono + TypeScript + Rust | Powered by Codex Desktop API</sub>
</div>
