<div align="center">

  <h1>Codex Proxy</h1>
  <h3>ローカル Codex コーディングアシスタント・ゲートウェイ</h3>
  <p>Codex Desktop の機能を OpenAI / Anthropic / Gemini 標準プロトコルとして公開し、あらゆる AI クライアントとシームレスに連携。</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
    <img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License">
  </p>

  <p>
    <a href="#-クイックスタート">クイックスタート</a> &bull;
    <a href="#-主な機能">主な機能</a> &bull;
    <a href="#-利用可能なモデル">利用可能なモデル</a> &bull;
    <a href="#-クライアント設定">クライアント設定</a> &bull;
    <a href="#-設定ガイド">設定ガイド</a> &bull;
    <a href="./API_JA.md">API リファレンス</a> &bull;
    <a href="#-謝辞と貢献者">謝辞と貢献者</a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> |
    <a href="./README_TW.md">繁體中文 (台湾)</a> |
    <a href="./README_HK.md">繁體中文 (香港)</a> |
    <a href="./README_EN.md">English</a> |
    <strong>日本語</strong>
  </p>

  <br>

  <a href="https://x.com/IceBearMiner"><img src="https://img.shields.io/badge/Follow-@IceBearMiner-000?style=flat-square&logo=x&logoColor=white" alt="X"></a>
  <a href="https://github.com/icebear0828/codex-proxy/issues"><img src="https://img.shields.io/github/issues/icebear0828/codex-proxy?style=flat-square" alt="Issues"></a>
  <a href="#-寄付--コミュニティ"><img src="https://img.shields.io/badge/Donate-WeChat-07C160?style=flat-square&logo=wechat&logoColor=white" alt="Donate"></a>

  <br><br>

  <table>
    <tr>
      <td align="center">
        <img src="./.github/assets/donate.png" width="180" alt="WeChat 寄付コード"><br>
        <sub>☕ 寄付</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/wechat.png" width="180" alt="WeChat コミュニティ"><br>
        <sub>💬 WeChat グループ</sub>
      </td>
      <td align="center">
        <img src="./.github/assets/tgimage.png" width="180" alt="Telegram コミュニティ"><br>
        <sub>💬 Telegram</sub>
      </td>
    </tr>
  </table>

</div>

---

**Codex Proxy** は、[Codex Desktop](https://openai.com/codex) の Responses API を各種標準プロトコル（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Gemini、Codex `/v1/responses` 直通、およびオプションの Ollama `/api/chat` 互換ブリッジ）に変換する軽量なローカル中継サービスです。本プロジェクトを利用することで、Cursor、Claude Code、Continue、Pi など、上記のプロトコルに対応するあらゆるクライアントで Codex コーディングモデルを直接活用できます。

ChatGPT アカウント（またはサードパーティ API プロバイダー）を用意するだけで、ローカル環境に専用の AI コーディングアシスタント・ゲートウェイを構築できます。

## 🚀 クイックスタート

> **前提条件**：ChatGPT アカウントが必要です（無料アカウントで利用可能）。まだお持ちでない場合は、[chat.openai.com](https://chat.openai.com) で登録してください。

<details>
<summary><h3>方法 1: デスクトップアプリ（初心者推奨）</h3></summary>

ダウンロード → インストール → 起動するだけですぐに使えます。

**インストーラーのダウンロード** — [Releases ページ](https://github.com/icebear0828/codex-proxy/releases) を開き、OS に合わせたパッケージをダウンロードします：

| OS | ファイル名 |
|----|------------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

インストール後にアプリを起動し、ログインボタンから ChatGPT アカウントでログインします。ブラウザで `http://localhost:8080` を開くとコントロールパネル（ダッシュボード）が表示されます。

</details>

<details>
<summary><h3>方法 2: Docker デプロイ</h3></summary>

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
# http://localhost:8080 を開いてログイン
```

> アカウントデータは `data/` ディレクトリに永続化され、再起動しても失われません。他のコンテナから本サービスへ接続する場合は `localhost` ではなくホストの LAN IP（例: `192.168.x.x:8080`）を使用してください。

`docker-compose.yml` 内の Watchtower のコメントアウトを解除すると自動更新が有効になります。Docker 内で Ollama 互換ブリッジを有効にする場合は、後述の [Ollama Bridge の設定](#ollama-bridge-の設定) を参照してください。

</details>

<details>
<summary><h3>方法 3: ソースコードから実行</h3></summary>

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install                        # バックエンド依存関係のインストール
cd web && npm install && cd ..     # フロントエンド依存関係のインストール
npm run dev                        # 開発モード（ホットリロード）
# または: npm run build && npm start # 本番モード
```

> **Rust ツールチェーンが必要**（TLS ネイティブアドオンのビルド用）：
> ```bash
> # 1. Rust のインストール（未導入の場合）
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> # 2. TLS アドオンのビルド
> cd native && npm install && npm run build && cd ..
> ```
> Docker / デスクトップアプリにはコンパイル済みアドオンが同梱されているため、手動ビルドは不要です。

ブラウザで `http://localhost:8080` を開いてログインします。

</details>

### 動作確認

ログイン後、ダッシュボード `http://localhost:8080` を開き、**API Configuration** エリアであなたの API Key を確認し、以下のコマンドを実行します：

```bash
# your-api-key をダッシュボードに表示されたキーに置き換えてください
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

AI からストリーミング応答が返ってくれば正常に動作しています。401 が返る場合は API Key が正しいか確認してください。

## 🌟 主な機能

### 🔌 全プロトコル完全互換
- `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、Gemini 形式、および `/v1/responses`（Codex 直通）に完全対応
- オプションの組み込み Ollama 互換ブリッジを搭載（デフォルトで `http://127.0.0.1:11434` をリッスン）
- SSE ストリーミング出力により、すべての OpenAI / Anthropic SDK やクライアントと直接連携可能
- Chat Completions / Anthropic / Gemini ↔ Codex Responses API の双方向プロトコル自動変換
- **Structured Outputs** — `response_format`（`json_object` / `json_schema`）および Gemini `responseMimeType` をサポート
- **Function Calling** — 全プロトコルでネイティブな `function_call` / `tool_calls` をサポート
- **サードパーティ API Key** — OpenAI / Anthropic / Gemini / OpenRouter / カスタム OpenAI 互換プロバイダーをサポートし、モデルごとのアップストリームルーティングに対応
- 📖 完全なエンドポイント定義と仕様については **[API リファレンス](./API_JA.md)** を参照してください。

### 🔐 アカウント管理とスマートローテーション
- **OAuth PKCE ログイン** — ブラウザからワンクリックで認証可能、手動での Token コピー不要
- **マルチアカウントローテーション** — `least_used`（最小使用優先）、`round_robin`（ラウンドロビン）、`sticky`（セッション固定）の3つの戦略
- **Plan Routing** — プラン別（free/plus/team/business）のアカウントをそれぞれサポートされているモデルへ自動ルーティング
- **Token 自動更新** — JWT 有効期限前に指数バックオフで自動リフレッシュ
- **クォータ収集** — アップストリームのレスポンスヘッダーや WebSocket の rate limit イベントからアカウントの利用枠を受動的に更新。手動クエリ時は `/backend-api/wham/usage` を呼び出し、`remaining_percent = 100 - used_percent` をキャッシュ
- **BAN 検知** — アップストリームの 403 応答で自動的に banned とマーク、401 トークン失効時は自動で期限切れ扱いにしてアカウントを切り替え
- **API Key プロバイダープール** — ダッシュボード上でサードパーティ API Key、モデル一覧、インポート/エクスポート、有効/無効状態を管理
- **Web コントロールパネル** — アカウント管理、利用統計、一括操作、日英中マルチ言語対応。リモートアクセス用のダッシュボード認証ゲートを搭載

### 🌐 プロキシプール
- **アカウント別プロキシルーティング** — アカウントごとに異なるアップストリームプロキシを設定可能
- **4つの割り当てモード** — Global Default / Direct / Auto / 指定プロキシ
- **ヘルスチェック** — 定期＋手動チェック、ipify による出口 IP とレイテンシ取得
- **到達不能の自動除外** — プロキシが利用不能になった際に自動でローテーションから除外

### 🛡️ 検出回避とプロトコル偽装
- **Rust Native TLS** — 内蔵の reqwest + rustls ネイティブアドオンにより、実際の Codex クライアントと完全に一致する TLS フィンガープリント（依存バージョン固定）
- **クライアント Profile プリセット** — `codex_cli`（デフォルト、公式 CLI クリーンターミナルヘッダー）、`codex_desktop`（Desktop 完全ヘッダー）、`opencode`、`pi`、`custom` をサポート。CLI モードではブラウザ固有ヘッダー（`sec-ch-ua` 等）を自動除去
- **アカウント別 Device ID 隔離** — アカウントごとに固有の `x-codex-installation-id` を個別に導出・永続化し、複数アカウント間での同一デバイス指紋共有を徹底防止
- **完全なリクエストヘッダーシミュレーション** — 選択されたプロファイルに応じて `originator`、`User-Agent`、`x-openai-internal-codex-residency`、`x-codex-turn-state`、`x-client-request-id` などを忠実に再現して送信
- **Cookie 永続化** — Cloudflare Cookie を自動キャプチャして再送
- **フィンガープリント自動更新** — Codex 更新フィードをポーリングし、`app_version` と `build_number` を自動同期

<details>
<summary><h2>🏗️ 技術アーキテクチャ</h2></summary>

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
             (TLS フィンガープリント = 実 Codex Desktop)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
             chatgpt.com   サードパーティ Provider
         /backend-api/codex  (サードパーティ API)
```

</details>

<details>
<summary><h2>📦 利用可能なモデル</h2></summary>

| モデル ID | 推論レベル | 現在のコンテキスト | 最大コンテキスト | 最大出力 | 出力種別 | 説明 |
|-----------|------------|-------------------|------------------|----------|----------|------|
| `gpt-5.6-sol` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | テキスト | GPT-5.6 フラッグシップ：高度な推論とコーディング（デフォルト、`gpt-5.6` はエイリアス） |
| `gpt-5.6-terra` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | テキスト | GPT-5.6 知能とコストのバランスモデル |
| `gpt-5.6-luna` | low / medium / high / xhigh / max / ultra | 1,050,000 | 1,050,000 | 128,000 | テキスト | GPT-5.6 高コストパフォーマンス / 高スループット |
| `gpt-5.5` | low / medium / high / xhigh | 272,000 | 272,000 | 128,000 | テキスト | 複雑なコーディング、研究、実践的ワークフロー向け |
| `gpt-5.4` | low / medium / high / xhigh | 272,000 | 1,000,000 | 128,000 | テキスト | 日常的なコーディングに強力なモデル |
| `gpt-5.4-mini` | low / medium / high / xhigh | 400,000 | — | 128,000 | テキスト | GPT-5.4 軽量版 |
| `gpt-5.3-codex` | low / medium / high / xhigh | 400,000 | — | 128,000 | テキスト | GPT-5.3 プログラミング特化モデル |
| `gpt-5.2` | low / medium / high / xhigh | 400,000 | — | 128,000 | テキスト | プロフェッショナル業務 + 長時間エージェントタスク |
| `gpt-5-codex` | low / medium / high | 400,000 | — | 128,000 | テキスト | GPT-5 プログラミング特化モデル |
| `gpt-5-codex-mini` | medium / high | — | — | — | テキスト | 軽量 Codex / CLI コーディングモデル |
| `gpt-oss-120b` | low / medium / high | 131,072 | — | — | テキスト | オープンソース 120B モデル |
| `gpt-oss-20b` | low / medium / high | 131,072 | — | — | テキスト | オープンソース 20B モデル |
| `gpt-image-2` | — | — | — | — | 画像 | 画像生成ツールバックエンド（`image_generation` 経由で呼び出し） |

> **サフィックス**：任意のチャットモデル名の末尾に `-fast` を付与すると Fast モード、`-high`/`-low`/`-max`/`-ultra` で推論レベルを切り替えられます（例: `gpt-5.6-sol-fast`、`gpt-5.6-sol-high-fast`、`gpt-5.6-sol-max`、`gpt-5.6-sol-ultra`）。画像モデル（`gpt-image-2`）はサフィックスに対応していません。
>
> **Plan Routing**：プラン別（free/plus/team/business）のアカウントは、ログインアカウントに対応する Codex バックエンドが返した利用可能なモデルへ自動ルーティングされます。過去の Plus 専用テーブルに縛られず柔軟に解釈してください。モデル一覧はバックエンドから動的に取得・自動同期されます。ダッシュボードや `/v1/models/catalog` に表示されているモデルは、リクエストの `model` として利用可能です。
>
> **ダッシュボードのモデル選択 ≠ 設定ファイル**：ダッシュボードでのモデル切り替えは、UI 表示および API サンプルのモデル名にのみ影響し、`config/default.yaml` や `data/local.yaml` の `model.default` を**変更しません**。実際に使用されるモデルはクライアントリクエスト内の `model` フィールド（Cursor や Claude Code 等で指定）によって決定され、設定ファイルの `model.default` はクライアントからモデルが指定されなかった場合のフォールバックとしてのみ機能します。
>
> **Max token について**：上表は現在の `config/models.yaml` および Codex ランタイム `/v1/models/catalog` メタデータに基づいています。`—` は現在のカタログで未返却のフィールドを意味し、モデルが利用不可であることを示すものではありません。実行時に Codex バックエンドから取得したモデル情報が静的設定を上書きし、`contextWindow`、`maxContextWindow`、`maxOutputTokens`、`truncationPolicyLimit` が保持されます。リクエストボディ内の `context_window` / `max_context_window` / `truncation_policy` / `max_output_tokens` は有効なパラメータではなく、Codex ネイティブエンドポイントへ直接転送すると `400 Unsupported parameter` が返されます。

### 🖼️ 画像生成

画像生成は `/v1/responses` の `image_generation` 組み込みツールを経由し、バックエンドは固定で `gpt-image-2` となります。

**前提条件**：ChatGPT **Plus 以上の**アカウント（無料アカウントではアップストリームでツールが無効化され、SVG テキストによる擬似描画にフォールバックします）。

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

主なパラメータ：`size`（1024×1024 / 1024×1536 / 1536×1024 / 2048×2048 / 2048×3072 / 3072×2048 / 3840×2160 / `auto` が指定可能）、`output_format`（`png` / `jpeg` / `webp`）、`output_compression`（jpeg / webp で調整可能）、`background`（`auto` / `opaque`）、`moderation`（`auto` / `low`）、`partial_images`（0–3）。1 回のリクエストで生成できる画像は 1 枚です（`n` は 1 固定）。リクエストの `model` フィールドに何を指定しても、アップストリームによって画像ツールの実際のモデル（現在は `gpt-image-2-codex`）に書き換えられます。詳細は [API_JA.md](./API_JA.md#image_generation-ツール) を参照してください。

> **`size` は厳密なピクセル寸法を保証するものではありません。** プロキシはクライアントが指定した値をそのまま保持して送信しますが、アップストリーム側で `2048x2048`、`2K`、`4K` などの指定が `size: "auto"` に正規化され、実際の解像度が決定される場合があります。2026-08-10 の実機検証では、`size: "2048x2048"` を指定したツール設定が `auto` としてエコーされ、最終的な `image_generation_call.size` および PNG ピクセルはいずれも `1254x1254` となりました。そのため、本フィールドでネイティブかつ正確な 2K/4K 出力を得ることは保証できません。結果アイテムの `size` またはデコード後の画像ピクセルサイズを基準としてください。業務上正確な `2048x2048` ファイルが必要な場合は、生成後に補間処理や AI 超解像によるポストプロセスを実施してください。

イベントストリーム内の `image_generation_call` アイテムの `result` フィールドに Base64 エンコードされた画像が含まれます。`revised_prompt` にはアップストリームによって最適化されたプロンプトが入ります。

**編集モード**（参照画像付き）：ユーザーメッセージの `content` に `{"type":"input_image","image_url":"data:image/png;base64,..."}` を追加します。

> `/v1/chat/completions` 互換エンドポイントでも `image_generation` ツールを受け付けるため OpenAI クライアントのスキーマ検証エラーは回避できますが、画像ペイロードは `/v1/responses` の `image_generation_call.result` でのみ安定して取得できます。画像データを取得したい場合は `/v1/responses` を利用してください。

</details>

## 🔗 クライアント設定

> すべてのクライアントで使用する API Key はコントロールパネル（`http://localhost:8080`）から取得してください。モデル名には具体的な ID（デフォルト: `gpt-5.6-sol`）または任意の [利用可能なモデル](#-利用可能なモデル) ID を入力します。

<details>
<summary><h3>Claude Code (CLI)</h3></summary>

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
# モデル切り替え: export ANTHROPIC_MODEL=gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.6-sol-fast ...
claude
```

> コントロールパネルの **Anthropic SDK Setup** カードから、環境変数（Opus / Sonnet / Haiku レベルのモデル設定を含む）をワンクリックでコピーできます。
>
> 推奨モデル：Opus → `gpt-5.6-sol`、Sonnet → `gpt-5.6-terra`、Haiku → `gpt-5.6-luna`。
>
> ⚠️ 設定が反映されない場合は、**[Claude Code 設定トラブルシューティングガイド](.github/guides/claude-code-setup.md)**（AUTH_TOKEN の乗っ取り、API Key ブラックリストなどのよくある問題）を参照してください。

</details>

<details>
<summary><h3>Codex CLI</h3></summary>

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

# config に直接 API Key を記載（推奨: ローカル単一ユーザー環境）
[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.6-sol"
model_provider = "proxy_codex"
```

> 💡 環境変数を使用することも可能です：`[model_providers.proxy_codex.http_headers]` の 2 行を削除し、`env_key = "PROXY_API_KEY"` に置き換えた上で、`export PROXY_API_KEY=your-api-key && codex` を実行します。共有環境や公開リポジトリなどで設定ファイルに秘密鍵を残したくない場合に有効です。

</details>

<details>
<summary><h3>Claude Desktop</h3></summary>

1. **開発者モードを有効化**：メニューバーの **Help** → **Troubleshooting** → **Enable Developer Mode** をクリック。
2. **サードパーティ推論の設定**：メニューバーに新しく表示された **Developer** → **Configure Third-Party Inference...** をクリック。
3. **設定を入力**：
   - **Endpoint**: `http://127.0.0.1:8080`
   - **API Key**: あなたの API Key
   - **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

> または設定ファイル（Windows では通常 `%APPDATA%\Claude-3p\configLibrary\` 配下の JSON ファイル、Mac では `~/Library/Application Support/Claude-3p/configLibrary/`）を手動編集し、以下の項目を追加します：
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

ビルトインの Claude 形式モデル名は自動的に Codex モデルへマッピングされます。カスタムマッピングは `config/models.yaml` ではなく `data/local.yaml` に記述してください：
```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.6-sol
    claude-sonnet-4-6: gpt-5.6-terra
    claude-haiku-4-5: gpt-5.6-luna
    my-openai: openai:gpt-4o
    my-deepseek: deepseek-chat
```

エイリアスの左側はクライアントリクエストで指定するモデル名、右側はアップストリームへ実際に送信されるモデル名です。右側には Codex モデル ID、プロバイダー接頭辞付きモデル（`openai:gpt-4o` / `anthropic:claude-sonnet-4-5` / `gemini:gemini-2.5-pro` など）、または `model_routing` でカスタムプロバイダーにバインドされたモデル名（`deepseek-chat` など）が指定できます。エイリアスは `/v1/models` に反映され、直接プロバイダーへ接続する際にモデル名が自動置換されます。

> 💡 **トラブルシューティング (Windows)**: `127.0.0.1` 指定時に Claude Desktop で `ERR_CONNECTION_REFUSED` が発生する（かつ `localhost` では URL 形式エラーになる）場合、システム上の Node.js がデフォルトで IPv6 のみにバインドされている可能性があります。Codex Proxy コントロールパネルの設定画面で **Host** を `127.0.0.1` に変更するか、`data/local.yaml` に `server: { host: "127.0.0.1" }` を追加して再起動してください。
> 
> 💡 **LAN 内利用に関する注意点 (LAN)**: Claude Desktop は API アドレスを厳密に検証し、`https://` で始まる URL または `http://127.0.0.1` のみを許可します。Codex Proxy を LAN 内の別マシン（例: `192.168.x.x`）にデプロイしている場合、直接指定するとエラーになります。解決策：
> 1. **SSH トンネル (最も簡単)**：クライアントマシン上で `ssh -L 8080:127.0.0.1:8080 user@192.168.x.x` を実行し、Claude 側には `http://127.0.0.1:8080` を入力します。
> 2. **リバースプロキシ**：Caddy や Nginx を使用して LAN 用の HTTPS 証明書を設定します。

</details>

<details>
<summary><h3>Codex Desktop (公式アプリ)</h3></summary>

公式クライアントは CLI と共通の設定ファイルを参照します。変更後はクライアントを再起動してください。

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.6-sol"
model_provider = "proxy_codex"
```

> 💡 **なぜ `env_key` ではないのか？** macOS / Windows の GUI アプリはシェルの `~/.zshrc` や `.bashrc` を読み込まないため、ターミナルで `export PROXY_API_KEY=...` を実行しても GUI プロセスには認識されず、起動時に `Missing environment variable` エラーとなります。`http_headers` で Authorization を config に直接記述すれば、`launchctl setenv` などの面倒な設定なしで Codex を再起動するだけで利用できます。設定ファイルからキーを切り離したい場合のみ `env_key = "PROXY_API_KEY"` を使用してください。
>
> ⚠️ 「ChatGPT アカウントでログイン」して利用している場合、クライアントがこの設定を無視することがあります。`[model_providers.proxy_codex]` が設定され、`profiles.default.model_provider = "proxy_codex"` となっている新規セッションはプロキシを経由しますが、ログイン済みセッションは直接公式アップストリームへ向かう場合があります。

</details>

<details>
<summary><h3>Claude for VSCode / JetBrains</h3></summary>

Claude 拡張機能の設定を開き、**API Configuration** を見つけます：
- **API Provider**: Anthropic を選択
- **Base URL**: `http://localhost:8080`
- **API Key**: あなたの API Key

または VS Code の `settings.json` に以下を追加します：
```json
{
  "claude.apiEndpoint": "http://localhost:8080",
  "claude.apiKey": "your-api-key"
}
```

</details>

<details>
<summary><h3>Cursor</h3></summary>

1. Settings → Models を開く
2. OpenAI API を選択
3. **Base URL**: `http://localhost:8080/v1` を設定
4. **API Key**: あなたの API Key を設定
5. モデル名 `gpt-5.6-sol`（またはその他のモデル ID）を追加

</details>

<details>
<summary><h3>Windsurf</h3></summary>

1. Settings → AI Provider を開く
2. **OpenAI Compatible** を選択
3. **API Base URL**: `http://localhost:8080/v1`
4. **API Key**: あなたの API Key
5. **Model**: `gpt-5.6-sol`

</details>

<details>
<summary><h3>Cline (VSCode 拡張機能)</h3></summary>

1. Cline サイドバーを開く → 設定アイコン（歯車）
2. **API Provider**: OpenAI Compatible を選択
3. **Base URL**: `http://localhost:8080/v1`
4. **API Key**: あなたの API Key
5. **Model ID**: `gpt-5.6-sol`

</details>

<details>
<summary><h3>Continue (VSCode 拡張機能)</h3></summary>

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

または環境変数を設定：
```bash
export OPENAI_API_BASE=http://localhost:8080/v1
export OPENAI_API_KEY=your-api-key
aider --model openai/gpt-5.6-sol
```

</details>

<details>
<summary><h3>Cherry Studio</h3></summary>

1. 設定 → モデルサービス → 追加
2. **種類**: OpenAI
3. **API アドレス**: `http://localhost:8080/v1`
4. **API Key**: あなたの API Key
5. モデル `gpt-5.6-sol` を追加

</details>

<details>
<summary><h3>Pi Coding Agent (pi)</h3></summary>

[Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) は、`~/.pi/agent/models.json` でカスタム Provider を設定して Codex Proxy に接続できます。

<details>
<summary>方法 1: OpenAI Completions プロトコル（推奨）</summary>

`~/.pi/agent/models.json` を編集：
```json
{
  "providers": {
    "codex-proxy": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "Codex GPT-5.6 Sol",
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "input": ["text", "image"]
        },
        {
          "id": "gpt-5.6-terra",
          "name": "Codex GPT-5.6 Terra",
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

> 💡 `apiKey` に `"$PROXY_API_KEY"` を指定し、ターミナルで `export PROXY_API_KEY=your-api-key` として注入することも可能です。

</details>

<details>
<summary>方法 2: Anthropic Messages プロトコル</summary>

```json
{
  "providers": {
    "codex-proxy-anthropic": {
      "baseUrl": "http://localhost:8080",
      "api": "anthropic-messages",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "Codex GPT-5.6 Sol",
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

</details>

<details>
<summary>方法 3: Codex Responses プロトコル（直通）</summary>

```json
{
  "providers": {
    "codex-proxy-responses": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-responses",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "name": "Codex GPT-5.6 Sol",
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

実行起動：
```bash
pi --provider codex-proxy --model gpt-5.6-sol
```

</details>

</details>

<details>
<summary><h3>Ollama 互換クライアント</h3></summary>

コントロールパネルの Settings → **Ollama Bridge** で有効化後、Ollama のデフォルトアドレスを利用できます：

| 項目 | 設定値 |
|------|--------|
| Base URL | `http://localhost:11434` |
| API Key | 不要（Bridge 内部で Codex Proxy のキーを使用してメインサービスへアクセスします） |
| Model | `gpt-5.6-sol`（またはその他のモデル ID） |

```bash
curl http://localhost:11434/api/tags

curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

> Ollama API 自体には認証機構がありません。デフォルトでは `127.0.0.1` のみをリッスンするため、パブリックネットワークや信頼できない LAN に公開しないようご注意ください。

</details>

<details>
<summary><h3>一般的な OpenAI 互換クライアント</h3></summary>

カスタム OpenAI API Base に対応したあらゆるクライアントを接続できます：

| 項目 | 設定値 |
|------|--------|
| Base URL | `http://localhost:8080/v1` |
| API Key | コントロールパネルから取得 |
| Model | `gpt-5.6-sol`（またはその他のモデル ID） |

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
<summary><h2>⚙️ 設定ガイド</h2></summary>

> **重要**：`config/default.yaml` を直接編集しないでください。バージョン更新時に上書きされます。カスタム設定はダッシュボードの設定パネルから変更（`data/local.yaml` に自動保存）するか、手動で `data/local.yaml` を作成して上書きしたい項目を記述してください。`data/` ディレクトリはアップデートの影響を受けません。

### CORS 許可ホスト

環境変数 `CORS_ALLOWED_HOSTS` を通じてクロスオリジンアクセスを許可するホスト一覧を設定できます（設定ファイル内の `server.cors` に対応）。複数のホスト名はカンマで区切ります：

```bash
export CORS_ALLOWED_HOSTS="example.com,another-domain.com"
```

または `data/local.yaml` で設定：

```yaml
server:
  cors:
    - "https://example.com"
    - "https://another-domain.com"
```

デフォルト設定は `config/default.yaml` にあります：

| 分類 | 主な設定項目 | 説明 |
|------|--------------|------|
| `server` | `host`, `port`, `proxy_api_key` | リッスンアドレスおよび API キー |
| `api` | `base_url`, `timeout_seconds` | アップストリーム API アドレスおよびタイムアウト |
| `client` | `profile`, `originator`, `app_version`, `build_number`, `platform`, `arch`, `chromium_version` | クライアント指紋プリセット（`codex_cli` / `codex_desktop` / `opencode` / `pi` / `custom`）およびバージョンメタデータ |
| `model` | `default`, `default_reasoning_effort`, `default_service_tier`, `aliases`, `custom_models`, `inject_desktop_context` | デフォルトモデル、推論設定、モデルマッピングおよびカスタムモデルカタログ |
| `auth` | `rotation_strategy`, `rate_limit_backoff_seconds` | ローテーション戦略およびレート制限バックオフ |
| `tls` | `proxy_url`, `force_http11` | TLS プロキシおよび HTTP バージョン |
| `quota` | `refresh_interval_minutes`, `warning_thresholds`, `skip_exhausted` | 利用量スナップショット、しきい値設定および枯渇アカウントスキップ |
| `session` | `ttl_minutes`, `cleanup_interval_minutes` | ダッシュボードセッション管理 |
| `ollama` | `enabled`, `host`, `port`, `version`, `disable_vision` | Ollama 互換ブリッジ |
| `official_agent` | `enabled`, `api_key`, `app_server_url`, `auth` | 公式 Codex app-server ブリッジ（Chrome/ブラウザプラグイン機能等の再利用） |

### クライアント Profile とフィンガープリントプリセット

`client.profile` でクライアント ID プリセットをワンクリックで切り替え、リクエストヘッダー構成と検出回避設定を自動調整できます：

```yaml
client:
  profile: codex_cli         # プリセット: codex_cli (デフォルト), codex_desktop, opencode, pi, custom
  # プリセット詳細：
  # - codex_cli:     公式 Codex CLI クリーンターミナルヘッダー (originator: codex_cli_rs)、ブラウザ固有ヘッダー (sec-ch-ua 等) を全除去
  # - codex_desktop: 公式 Codex Desktop 完全ヘッダー (originator: Codex Desktop)、sec-ch-ua および Chromium バージョンを含む
  # - opencode:      opencode ターミナルヘッダー (originator: opencode)
  # - pi:            pi ターミナルヘッダー (originator: pi)
  # - custom:        完全カスタムモード、client.originator および fingerprint.yaml テンプレートを読み込み
```

また、プロキシは連携された各アカウントごとに専用の `x-codex-installation-id` を自動導出・永続化（`data/installation_ids/` に保存）し、複数アカウントの並行利用/ローテーション時にも各アカウントが独立したクライアントデバイス ID を保持できるようにすることで、アップストリームによるデバイス UUID 紐付けを防ぎます。

### モデルエイリアス（マッピング）

`model.aliases` はクライアント側のモデル名を実際のアップストリームモデルにマッピングするために使用します。Claude Desktop / Cursor / Continue などのクライアントで固定モデル名しか選べない場合や、短い別名を使いたい場合に適しています。

ダッシュボードの Settings → **Model Aliases** から直接マッピングを追加/削除することも可能です。保存すると `data/local.yaml` に書き込まれ、バックエンドへ即時反映されるため、`config/default.yaml` を変更する必要はありません。

```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.6-sol
    sonnet-local: gpt-5.6-terra
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

エイリアス解決は `model_routing` や組み込みの Claude/Gemini 自動ルーティングよりも前に処理されます。Codex モデルへマッピングされた場合でも `-fast` / `-high` などのサフィックスは引き続き利用可能です。サードパーティプロバイダーへマッピングされた場合は、ダイレクト接続リクエストの `model` フィールドが右側のターゲット値に書き換えられます。

完全にカスタムな Codex 互換モデル ID をモデルカタログに追加したい場合は、`data/local.yaml` に `model.custom_models` を設定します。シンプルな文字列指定ではデフォルトの text/medium メタデータが適用されます。オブジェクト形式で記述することで、表示名、推論レベル、コンテキスト長、出力上限などを詳細に定義できます：

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

### クォータローテーション

`quota.skip_exhausted: true` の場合、アカウントプールはアカウントを選択する前に、キャッシュされたクォータが既に枯渇しているアカウントをスキップします。このフィルタリングは session affinity / `preferredEntryId` の適用前に実施されるため、長時間の会話でも枯渇済みアカウントに強制固定されることはありません。

現在のスキップ条件は、キャッシュ内の `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true`、または `code_review_rate_limit.limit_reached === true` です。単に `used_percent` が 100 に近い（例: 99%）だけでアップストリームが `limit_reached` を返していない場合は引き続き利用されます。実際にアップストリームから 429 が返された時点で `rate_limited` バックオフ状態となり、別のアベイラブルなアカウントへ切り替わります。secondary や code review ウィンドウ自身の `reset_at` が経過するとキャッシュからクリアされるため、古いクォータ情報によってアカウントが永久にスキップされることはありません。

### LAN（ローカルネットワーク）アクセス

ソースコードのデフォルト設定は `127.0.0.1` のみをリッスンします。Electron も `data/local.yaml` で明示的に上書きされない限り `127.0.0.1` を渡します。Docker イメージは `CODEX_PROXY_HOST=0.0.0.0` によりコンテナ内ですべてのインターフェースをリッスンしますが、`docker-compose.yml` はデフォルトでホスト側ポートを `127.0.0.1` にのみバインドしています。

ローカルマシンからのみアクセスする場合：

```yaml
server:
  host: "127.0.0.1"
```

LAN 内の別デバイスからアクセスする場合は、`data/local.yaml` に以下を追加し、`docker-compose.yml` のポートマッピングを `127.0.0.1:${PORT:-8080}:8080` から `${PORT:-8080}:8080` に変更します：

```yaml
server:
  host: "0.0.0.0"
```

Electron デスクトップ版の `data/local.yaml` パス：

| OS | パス |
|----|------|
| macOS | `~/Library/Application Support/Codex Proxy/data/local.yaml` |
| Windows | `%APPDATA%/Codex Proxy/data/local.yaml` |
| Linux | `~/.config/Codex Proxy/data/local.yaml` |

> ⚠️ `0.0.0.0` にバインドするとサービスが LAN 内に公開されるため、必ずダッシュボードのキー設定で強固な API キーを設定してください。

### TLS 設定

```yaml
tls:
  proxy_url: null                  # null = ローカルプロキシを自動検出。プロキシ URL を指定してアップストリームプロキシを設定
  force_http11: false              # HTTP/2 失敗時に HTTP/1.1 へ自動フォールバック。true = HTTP/1.1 を強制
```

> 内蔵の Rust ネイティブアドオン（reqwest + rustls）により、TLS フィンガープリントは実際の Codex Desktop と完全に一致します。ソースから実行する場合はビルドが必要です：`cd native && npm install && npm run build`。

### API キー

```yaml
server:
  proxy_api_key: "pwd"    # カスタムキー。クライアントは Bearer pwd でアクセス
  # proxy_api_key: null   # null = グローバルキーを設定しない。ログイン済みアカウントは個別の codex-proxy-xxxx キーを生成
```

初回起動時に `data/local.yaml` が存在しない場合、自動的に `server.proxy_api_key: pwd` が作成されます。現在有効なキーはコントロールパネルの API Configuration エリアに表示されます。

### Ollama Bridge の設定

```yaml
ollama:
  enabled: false          # true = 組み込み Ollama 互換リスナーを起動
  host: 127.0.0.1         # デフォルトはローカルマシンのみアクセス可能
  port: 11434             # Ollama デフォルトポート
  version: "0.18.3"       # /api/version の返却値
  disable_vision: false   # true = /api/show で vision 機能を宣言しない
```

サポートされている Ollama エンドポイント：

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `http://localhost:11434/api/version` | GET | Ollama バージョン確認 |
| `http://localhost:11434/api/tags` | GET | モデル一覧 |
| `http://localhost:11434/api/show` | POST | モデルメタデータ |
| `http://localhost:11434/api/chat` | POST | チャット補全（NDJSON ストリーミング対応） |
| `http://localhost:11434/v1/*` | 任意 | OpenAI `/v1` 直通 |

Docker デプロイでホスト側から `11434` にアクセスする場合：

1. ダッシュボードまたは `data/local.yaml` で `ollama.enabled: true` および `ollama.host: 0.0.0.0` を設定。
2. `docker-compose.yml` 内の `127.0.0.1:${OLLAMA_BRIDGE_PORT:-11434}:11434` ポートマッピングのコメントアウトを解除。
3. 認証不要の Ollama API を意図的にネットワーク公開する場合を除き、ホスト側バインドは `127.0.0.1` のままにしてください。

ブラウザからの CORS アクセスは `localhost`、`127.x.x.x`、`::1` などのループバックオリジンのみに制限されています。ローカル外の Web オリジンからブリッジ応答を読み取ることはできません。Bridge は `/v1/*` 直通リクエストに対して設定済みの Codex Proxy API Key を注入するため、localhost 以外に公開することはメインプロキシ API を認証なしで公開することと同等になります。

### Official Agent Bridge の設定

ローカルの公式 `codex app-server` に接続し、Codex app の公式 Chrome/ブラウザ拡張機能、承認機能、app mention 機能を再利用するためのブリッジです。デフォルトは無効であり、既存の `/v1/*` モデルプロキシには影響しません。

まず公式の app-server を起動します：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

次に `data/local.yaml` で有効化します：

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

app-server が capability token を使用している場合：

```bash
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/path/to/token
```

対応する設定：

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

利用可能なエンドポイント：

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

### 環境変数による上書き

| 環境変数 | 上書きされる設定項目 |
|----------|----------------------|
| `PORT` | `server.port` |
| `CODEX_PROXY_HOST` | `server.host`（`data/local.yaml` で明示的に未設定の場合のみ有効） |
| `CODEX_PLATFORM` | `client.platform` |
| `CODEX_ARCH` | `client.arch` |
| `HTTPS_PROXY` | `tls.proxy_url` |
| `OLLAMA_BRIDGE_ENABLED` | `ollama.enabled` |
| `OLLAMA_BRIDGE_HOST` | `ollama.host` |
| `OLLAMA_BRIDGE_PORT` | `ollama.port` |
| `OLLAMA_BRIDGE_VERSION` | `ollama.version` |
| `OLLAMA_BRIDGE_DISABLE_VISION` | `ollama.disable_vision` |

</details>

<details>
<summary><h2>📡 API エンドポイント</h2></summary>

**プロトコルエンドポイント**

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `/v1/chat/completions` | POST | OpenAI 形式チャット補全 |
| `/v1/responses` | POST | Codex Responses API 直通 |
| `/v1/responses/compact` | POST | Codex リモート compact レスポンスプロキシ |
| `/v1/alpha/search` | POST | Codex スタンドアロン Web Search（`codex-responses` API-key wire） |
| `/v1/images/generations` | POST | Codex JSON 画像生成直通（`codex-responses` API-key wire） |
| `/v1/images/edits` | POST | Codex JSON 画像編集直通（`codex-responses` API-key wire） |
| `/v1/messages` | POST | Anthropic 形式チャット補全 |
| `/v1/models` | GET | 利用可能なモデル一覧 |
| `/v1/models/catalog` | GET | ダッシュボード用完全モデルカタログ |
| `/v1/models/:modelId/info` | GET | 単一モデルの推論レベル等の詳細情報 |
| `/v1beta/models` | GET | Gemini 形式モデル一覧 |
| `/v1beta/models/:modelAction` | POST | Gemini `generateContent` / `streamGenerateContent` |
| `:11434/api/chat` | POST | Ollama 互換チャット補全（Ollama Bridge 有効時） |

**アカウント & 認証**

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `/auth/login` | GET | OAuth ログイン入口 |
| `/auth/accounts` | GET | アカウント一覧（キャッシュされたクォータを含む） |
| `/auth/accounts` | POST | 単一アカウントの追加（token または refreshToken） |
| `/auth/accounts/import` | POST | アカウントの一括インポート（JSON / `text/plain` token 行） |
| `/auth/accounts/export` | GET | アカウントのエクスポート（`?format=full|minimal|cockpit_tools|sub2api|cpa`） |
| `/auth/accounts/batch-delete` | POST | アカウントの一括削除 |
| `/auth/accounts/batch-status` | POST | アカウント状態の一括更新 |
| `/auth/accounts/health-check` | POST | アカウント有効性の一括ヘルスチェック |
| `/auth/accounts/:id/refresh` | POST | 単一アカウントのリフレッシュと疎通確認 |
| `/auth/accounts/:id/quota` | GET | 単一アカウントのクォータ手動クエリ |
| `/auth/accounts/:id/cookies` | GET/POST/DELETE | アカウントの Cloudflare cookies 管理 |
| `/auth/quota/warnings` | GET | 現在のクォータ警告ステータス |

**サードパーティ API Key**

標準 Responses API 上で公式 Codex クライアントコンテキストを要求する API-key アップストリームの場合、ダッシュボードで `Custom` プロバイダーおよび `Codex Responses (client context)` プロトコルを選択してください。Base URL には API v1 のルートアドレス（例: `https://provider.example.com/v1`、末尾に `/responses` を付けない）を入力します。このプロトコルの主 Responses リクエストは HTTP SSE を使用し、Codex ヘッダー、installation/session/thread/window ID、クライアントメタデータを送信します。また、リクエストボディの `model` に基づくスタンドアロン Web Search、リモート compact、Codex JSON 画像生成/編集エンドポイントのルーティングもサポートします（Embeddings は非対応）。プロバイダーが互換性のある `/models` エンドポイントを提供していない場合は、ダッシュボード上でモデル名を手動入力できます。

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `/auth/api-keys/catalog` | GET | 内蔵プロバイダーおよび推奨モデルカタログ |
| `/auth/api-keys` | GET/POST | API Key 一覧 / 追加 |
| `/auth/api-keys/models` | POST | カスタム OpenAI 互換プロバイダーからモデル取得 |
| `/auth/api-keys/export` | GET | API Key 設定のエクスポート |
| `/auth/api-keys/import` | POST | API Key 設定のインポート |
| `/auth/api-keys/batch-delete` | POST | API Key の一括削除 |
| `/auth/api-keys/:id` | DELETE | 単一 API Key の削除 |
| `/auth/api-keys/:id/label` | PATCH | API Key ラベルの変更 |
| `/auth/api-keys/:id/status` | PATCH | API Key の有効化 / 無効化 |

**アカウントのインポート / エクスポート例**

```bash
# 全アカウントのエクスポート（token を含む完全フォーマット）
curl -s http://localhost:8080/auth/accounts/export \
  -H "Authorization: Bearer your-api-key" > backup.json

# 簡易フォーマットのエクスポート（refreshToken + label のみ、共有用）
curl -s "http://localhost:8080/auth/accounts/export?format=minimal" \
  -H "Authorization: Bearer your-api-key" > backup-minimal.json

# サードパーティ互換フォーマットのエクスポート
curl -s "http://localhost:8080/auth/accounts/export?format=sub2api" \
  -H "Authorization: Bearer your-api-key" > sub2api-accounts.json

# 一括インポート（token、refreshToken、または両方の指定に対応）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "accounts": [
      { "token": "eyJhbGciOi..." },
      { "refreshToken": "v1.abc..." },
      { "refreshToken": "v1.def...", "label": "予備アカウント" }
    ]
  }'
# 返却例: { "added": 2, "updated": 1, "failed": 0, "errors": [] }

# text/plain token 行インポート（1行ごとに access token または refresh token）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: text/plain" \
  -H "Authorization: Bearer your-api-key" \
  --data-binary $'eyJhbGciOi...\noaistb_rt_...\n'

# バックアップ復元のワンステップ実行（エクスポートファイルをそのまま別インスタンスへ投入）
curl -X POST http://localhost:8080/auth/accounts/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d @backup.json
```

**管理インターフェース**

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `/admin/rotation-settings` | GET/POST | ローテーション戦略設定 |
| `/admin/quota-settings` | GET/POST | クォータ更新・警告設定 |
| `/admin/ollama-settings` | GET/POST | Ollama Bridge 設定 |
| `/admin/ollama-status` | GET | Ollama Bridge 稼働ステータス |
| `/admin/refresh-models` | POST | モデル一覧の手動リフレッシュ |
| `/admin/usage-stats/summary` | GET | 利用統計サマリー |
| `/admin/usage-stats/history` | GET | 利用時系列データ |
| `/admin/logs` | GET | リクエストログ一覧 |
| `/admin/logs/state` | GET/POST | ログ収集の有効/無効および設定 |
| `/admin/update-status` | GET | 自動更新ステータス |
| `/admin/check-update` | POST | 更新確認 |
| `/admin/apply-update` | POST | 自動更新の実行 |
| `/health` | GET | ヘルスチェック |

**プロキシプール**

| エンドポイント | メソッド | 説明 |
|----------------|----------|------|
| `/api/proxies` | GET/POST | プロキシ一覧 / 追加 |
| `/api/proxies/:id` | PUT/DELETE | プロキシの更新 / 削除 |
| `/api/proxies/:id/check` | POST | 単一プロキシのヘルスチェック |
| `/api/proxies/check-all` | POST | 全プロキシのヘルスチェック |
| `/api/proxies/assign` | POST | アカウントへのプロキシ割り当て |
| `/api/proxies/assignments` | GET | アカウントのプロキシ割り当て状況確認 |
| `/api/proxies/assign-bulk` | POST | プロキシの一括割り当て |
| `/api/proxies/assign-rule` | POST | ルールに基づくプロキシ割り当て |
| `/api/proxies/export` | GET | プロキシプール YAML のエクスポート |
| `/api/proxies/import` | POST | プロキシプール YAML のインポート |

</details>

## 📋 動作要件

- **Node.js** 18+（20+ 推奨）
- **Rust** — ソースから実行する場合に必要（TLS ネイティブアドオンのビルド用）。Docker / デスクトップアプリには同梱済み
- **ChatGPT アカウント** — 無料アカウントで利用可能
- **Docker**（オプション）

## ⚠️ 注意事項

- Codex API は**ストリーミング専用**です。`stream: false` を指定した場合はプロキシ内部でストリームを受信・集約した上で完全な JSON を返却します。
- 本プロジェクトは Codex Desktop の公開インターフェースに依存しています。アップストリームのバージョン更新時は自動的に検知してフィンガープリントを更新します。
- Windows 環境でソースからビルドする場合、ネイティブ TLS アドオンのコンパイルに Rust ツールチェーンが必要です（Docker デプロイではビルド済みのため不要）。

## 📝 最近の更新

詳細な変更履歴は [CHANGELOG.md](./CHANGELOG.md) をご確認ください。

## ☕ 寄付 & コミュニティ

お役に立ちましたか？開発者にコーヒーを奢る、または WeChat グループでサポートを受けることができます。QR コードは [ページ上部](#) をご覧ください。

## 🙏 謝辞と貢献者

Codex Proxy は当初個人の用途から始まりましたが、想像を超える多くのご支援とご支持をいただいて成長してきました。

コード、ドキュメント、バグ修正、PR を通じてプロジェクトに貢献してくださったすべての開発者に深く感謝いたします：

[@SsuJojo](https://github.com/SsuJojo) · [@TutuchanXD](https://github.com/TutuchanXD) · [@kanweiwei](https://github.com/kanweiwei) · [@et2010](https://github.com/et2010) · [@d-demand-priv](https://github.com/d-demand-priv) · [@hangox](https://github.com/hangox) · [@jarvisluk](https://github.com/jarvisluk) · [@jeasonstudio](https://github.com/jeasonstudio) · [@JPClaw12](https://github.com/JPClaw12) · [@lezi-fun](https://github.com/lezi-fun) · [@lookvincent](https://github.com/lookvincent) · [@pocper1](https://github.com/pocper1) · [@woai66](https://github.com/woai66) · [@xsShuang](https://github.com/xsShuang) · [@yuwei5380](https://github.com/yuwei5380) · [@aeltorio](https://github.com/aeltorio) · [@williamjameshandley](https://github.com/williamjameshandley) · [@FlavienKlr](https://github.com/FlavienKlr) · [@zyycn](https://github.com/zyycn)

また、[Issues](https://github.com/icebear0828/codex-proxy/issues) でバグ再現手順、ログ、互換性フィードバック、新機能の提案を寄せてくださったすべてのユーザーに感謝いたします。これらのフィードバックがアカウントローテーション、プロキシ互換性、Dashboard、Ollama Bridge、モデル互換性、エラー可観測性などの進化を強力に後押ししました。

**そして何よりも、本プロジェクトを静かに利用し、見守り、応援してくださる世界中の開発者の皆様に心より感謝申し上げます。皆様の評価と愛着こそが、今日までメンテナンスと改善を続けられた原動力です。これほど多くの方に Codex Proxy を気に入っていただけて本当に嬉しく思います！** ❤️

## ⭐ Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=icebear0828/codex-proxy&type=Date)](https://star-history.dera.page/#icebear0828/codex-proxy&Date)

## 📄 ライセンス

本プロジェクトは **非商用ライセンス (Non-Commercial)** を採用しています：

- **許可**：個人の学習、研究、自己利用目的でのデプロイ
- **禁止**：販売、再販、有料プロキシサービスの提供、商用製品への組み込みを含むあらゆる商用利用

本プロジェクトは OpenAI とは一切関係ありません。利用者は自己責任において利用し、OpenAI の利用規約を遵守する必要があります。

---

<div align="center">
  <sub>Built with Hono + TypeScript + Rust | Powered by Codex Desktop API</sub>
</div>
