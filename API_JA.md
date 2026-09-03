# Codex Proxy API リファレンス

[English](./API.md) | [简体中文](./API_CN.md) | [繁體中文 (台湾)](./API_TW.md) | [繁體中文 (香港)](./API_HK.md) | **日本語**

---

## 認証方法

すべてのプロキシエンドポイント（chat / messages / gemini / responses / embeddings / images）は、設定されたプロキシ API キーを受け付けます：
- リクエストヘッダー：`Authorization: Bearer {proxy_api_key}`、`x-api-key: {proxy_api_key}`、または `x-goog-api-key: {proxy_api_key}`
- クエリパラメータ：`?key={proxy_api_key}`

### クライアントアクセスキー（サブキー）
クライアントは、管理ダッシュボードまたは Admin API で作成されたきめ細かなクライアントキー（Client Key）を使用して認証することもできます。サブキーは、USD 予算制限、トークン上限、同時実行数制限、許可モデルの制限、および有効期限をサポートしています。
- サブキー自己照会エンドポイント：`GET /v1/sub-key/info`（`Authorization: Bearer {client_key}` が必要）。

### ダッシュボードおよび管理者認証
- ダッシュボード UI は cookie セッション（`_codex_session`）を使用します。
- 管理者エンドポイント（`/admin/*`）には、有効なダッシュボードセッション、または `Authorization: Bearer {master_api_key}` によるマスタープロキシ API キーが必要です。

---

## API プロキシエンドポイント

### POST /v1/chat/completions
OpenAI 互換のチャット補完インターフェース。

```jsonc
// リクエスト
{
  "model": "gpt-5.6-sol",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "reasoning_effort": "medium"  // オプション: low | medium | high | xhigh
}
```

- ストリーミング：SSE、イベントに `choice.delta` を含む
- 非ストリーミング：`{ id, choices, usage }`
- エラー形式：`{ error: { message, type, code } }`
- `max_tokens`、`max_completion_tokens`、`max_output_tokens` はクライアント互換性のために受け入れられますが、Codex ネイティブバックエンドには転送されません。

### POST /v1/messages
Anthropic Messages API 互換インターフェース。

```jsonc
// リクエスト
{
  "model": "claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true,
  "thinking": {"type": "enabled"}  // オプション
}
```

- 認証：`x-api-key` または `Authorization: Bearer`
- エラー形式：`{ type: "error", error: { type, message } }`

### POST /v1beta/models/:model:generateContent
### POST /v1beta/models/:model:streamGenerateContent
Google Gemini 互換インターフェース。

```jsonc
// リクエスト
{
  "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
  "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  "systemInstruction": {"parts": [{"text": "あなたは親切なアシスタントです。"}]}
}
```

- 認証：`x-goog-api-key` ヘッダー、`key` クエリパラメータ、または Bearer トークン
- エラー形式：`{ error: { code, message, status } }`

### POST /v1/responses
ネイティブ Codex Responses API パススルー（HTTP POST + SSE）。

```jsonc
// リクエスト
{
  "model": "gpt-5.6-sol",
  "instructions": "あなたは親切なアシスタントです。",
  "input": [{"type": "message", "content": "Hello"}],
  "stream": true,
  "reasoning": {"effort": "medium"},
  "tools": [],
  "previous_response_id": "resp_xxx"  // マルチターン会話の再開
}
```

- ストリーミング：SSE イベント `response.created`、`response.output_text.delta`、`response.completed`
- 非ストリーミング：`{ response, usage, responseId }`
- ネイティブ Codex に `max_output_tokens` を送信しないでください。プロキシは互換性のためにのみ受け入れて除外します。実際の Codex バックエンドは `400 Unsupported parameter: max_output_tokens` で拒否します。

### WebSocket /v1/responses
ネイティブ Codex Responses API WebSocket トランスポート（Issue #681）。

クライアントは、標準認証（例：`Authorization: Bearer {key}` ヘッダーまたは `?key={key}` クエリパラメータ）を使用して、WebSocket 経由で `ws://{host}:{port}/v1/responses`（または `wss://`）に接続できます。

- 接続は持続し、マルチターン対話をサポートします。
- クライアントは `response.create` JSON フレームを送信します。
- プロキシはリクエストを実行し、SSE の `data:` JSON ペイロードを個別の WebSocket テキストフレームとしてクライアントにストリーミングします。

### POST /v1/images/generations
OpenAI Images API 互換の画像生成インターフェース。

```jsonc
// リクエスト
{
  "model": "gpt-image-2",
  "prompt": "雪山に沈む夕日の風景",
  "size": "1024x1024",
  "output_format": "png"
}
```

- プロキシは画像生成リクエストを Codex Responses の `image_generation` ツール呼び出しに変換し、設定された `model.image_host_model`（デフォルト: `gpt-5.5`）にルーティングします。
- OpenAI 互換の `{ created, data: [{ b64_json, revised_prompt }] }` を返します。

### POST /v1/embeddings
OpenAI 互換の埋め込み（Embeddings）インターフェース。

```jsonc
// リクエスト
{
  "model": "text-embedding-3-small",
  "input": "テキストをここに入力します"
}
```

- `embeddings` 機能が明示的に設定されたサードパーティ Provider API キーにルーティングされます。
- `{ object: "list", data: [{ object: "embedding", embedding: [...], index: 0 }], model, usage }` を返します。

---

### Codex 補助エンドポイント

`POST /v1/alpha/search` は ChatGPT OAuth アカウントプールで提供される通常の Codex モデルをサポートし、リクエストを `/backend-api/codex/alpha/search` に転送します。リクエストモデルが `wire=codex-responses` を持つ API キープロバイダーに解決される場合、プロキシは以下の非ストリーミング JSON エンドポイントもすべてサポートします：

| エンドポイント | アップストリーム先 | 用途 |
|---|---|---|
| `POST /v1/alpha/search` | `<baseUrl>/alpha/search` | Codex CLI スタンドアロン Web 検索 |
| `POST /v1/responses/compact` | `<baseUrl>/responses/compact` | リモート会話コンパクション |
| `POST /v1/images/generations` | `<baseUrl>/images/generations` | Codex JSON 画像生成 |
| `POST /v1/images/edits` | `<baseUrl>/images/edits` | Codex JSON 画像編集 |

各エンドポイントは JSON ボディに空でない `model` を必要とし、既存のモデルルーターを使用します。OAuth 検索はアカウントプールの Cookie、プロキシ選択、再試行・ローテーション、Codex リクエストコンテキストを再利用します。API キールートではローカル認証を設定済みプロバイダーキーに置き換えます。設定されたモデルエイリアス解決、内部プロバイダープレフィックスの削除、および後述の Responses Lite 正規化を除き、JSON ボディは変更されず、アップストリームのステータス、Content-Type、レスポンスボディがそのまま返されます。ホワイトリスト外のパスは転送されません。`v1` なしのローカルエイリアスも受け入れられます。詳細は [OpenAI Responses compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact/) および [Codex CLI 0.147.0 検索エンドポイントソース](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/codex-api/src/endpoint/search.rs#L31-L45) を参照してください。

Responses の生成および compact リクエストでは、`x-openai-internal-codex-responses-lite: true`、または同等の WebSocket マーカーが `client_metadata` に含まれる場合、プロキシは完全な Responses Lite 契約を適用し、`reasoning.context=all_turns` と `parallel_tool_calls=false` を強制します。保持されるコンテキストと token 使用量が増え、ツール呼び出しが直列化される可能性がありますが、Lite マーカーとリクエストボディの不整合によるアップストリーム拒否を防ぎます。

#### image_generation ツール

`tools[]` 内で `{"type": "image_generation", ...}` を宣言すると、モデルがサーバー側の画像生成バックエンド（`gpt-image-2`）を呼び出せるようになります。**ChatGPT Plus 以上** のアカウントが必要です（無料プランではアップストリーム側でツールが自動的に削除され、モデルは SVG テキストの返却にフォールバックします）。

**サポートされているフィールド**（`type` 以外はすべてオプション）：

| フィールド | 列挙値 / 範囲 | デフォルト | 備考 |
|---|---|---|---|
| `size` | `1024x1024`, `1024x1536`, `1536x1024`, `2048x2048`, `2048x3072`, `3072x2048`, `3840x2160` (4K UHD), `2160x3840` (4K 縦), `2304x3072` (3:4), `auto` | `auto` | 幅と高さは両方とも 16 の倍数である必要があります。最長辺 ≤ 3840 px。総ピクセル予算 ≈ 8 MP（`3072x3072` は拒否）。1024 px 未満の解像度も拒否されます |
| `output_format` | `png` / `jpeg` / `webp` | `png` | `gif` は拒否されます |
| `output_compression` | 整数 0–100 | `100` | **jpeg / webp のみ有効** — PNG では 100 以外拒否 |
| `background` | `auto` / `opaque` | `auto` | `transparent` はこのモデルでは拒否されます |
| `moderation` | `auto` / `low` | `auto` | その他の列挙値は拒否されます |
| `partial_images` | 整数 0–3 | 0 | `>3` は拒否されます |

**自動書き換え / 拒否されるフィールド**：

- `model` — 何を送信しても、アップストリームによって `gpt-image-2`（レスポンスでは `gpt-image-2-codex`）に強制されます。
- `size` — `2048x2048`、`2K`、`4K` などの指定はアップストリームで `auto` に正規化され、実際の解像度はサーバー側で決定されます（例: 実測 `1254x1254`）。
- `quality` — どの値を送信しても `auto` としてエコーバックされ、ユーザー指定値は効果を持ちません。
- `n` — 拒否されます（`unknown_parameter`、1 回の呼び出しにつき 1 枚）。
- `input_image`, `mask`, `input_fidelity`, `style`, `response_format` — すべて拒否されます。

**イベントストリームの順序**（モデルがツールを呼び出す場合）：

1. `response.created` — アップストリームで正規化されたフィールドを含む `tools[]` をエコー。
2. `response.output_item.added` — `{type: "image_generation_call", ...}`。
3. `response.image_generation_call.in_progress` → `.generating` → （オプション）`.partial_image` × N。
4. `response.output_item.done` — 完了した `image_generation_call`：
   - `result` — base64 エンコードされた画像バイト列（`output_format` に従う）。
   - `revised_prompt` — モデルが実際に使用した最終プロンプト。
5. `response.completed`。

**トークン計算**：`response.completed.response.usage` はホストモデルのトークンを報告します。画像ツールのトークンは個別に `response.completed.response.tool_usage.image_gen.{input_tokens, output_tokens, total_tokens}` として返されます。プロキシは両方をそのまま透過し、ダッシュボード上で独立したカウンター（`total_image_input_tokens` / `total_image_output_tokens`）として追跡するため、画像生成のトークンがホストモデルのトークンチャートを乱すことはありません。

**リクエスト数集計**：プロキシは各 `image_generation` リクエストの成功/失敗も集計します。アップストリームが実際の画像を返した場合（`tool_usage.image_gen.output_tokens > 0`）に `total_image_request_count` が増加します。ツールが自動削除された場合（無料プラン）、アップストリームエラー、空のレスポンスなどの場合は `total_image_request_failed_count` が増加します。両方とも `/admin/usage-stats/summary` およびダッシュボードの「Image Requests」カードで確認できます。

**編集モード**（参照画像の提供）：ユーザーメッセージの content 配列内に `input_image` ブロックを追加します。`data:` URL および HTTPS URL の両方がサポートされます。

```jsonc
{
  "model": "gpt-5.6-sol",
  "stream": true,
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "この空を夕焼けにしてください。"},
      {"type": "input_image", "image_url": "data:image/png;base64,AAA...", "detail": "high"}
    ]
  }],
  "tools": [{"type": "image_generation", "size": "1024x1024"}]
}
```

有効な content-part タイプ（アップストリーム検証による）：`input_text`, `input_image`, `output_text`, `refusal`, `input_file`, `computer_screenshot`, `summary_text`。

OpenAI Chat 互換パスは `tools: [{"type":"image_generation"}]` を受け入れますが、安定した画像ペイロードは `/v1/responses` の `image_generation_call.result` を介してのみ公開されます。base64 画像バイトが必要なクライアントは、`/v1/responses` または `POST /v1/images/generations` を使用してください。

---

### Ollama 互換ブリッジ

オプションのブリッジは、デフォルトで `http://127.0.0.1:11434` の個別リスナーで動作します。デフォルトは無効になっており、ダッシュボード設定または Admin API から制御できます。Ollama エンドポイントは意図的に認証なしとなっているため、信頼できるネットワークでない限り localhost にバインドしたままにしてください。

ブラウザの CORS アクセスはループバックオリジン（`localhost`、`127.x.x.x`、`::1`）に制限されているため、ローカル以外の Web ページはデフォルトでブリッジレスポンスを読み取ることができません。ブリッジは `/v1/*` パススルーリクエストに対して設定済みの Codex Proxy API キーを注入するため、localhost 以外に公開すると、クライアントがキーを知らなくてもメインプロキシ API にアクセスできるようになります。

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/api/version` | バージョン確認 → `{ version }` |
| GET | `/api/tags` | Ollama 形式のモデル一覧 |
| POST | `/api/show` | モデルのメタデータと機能 |
| POST | `/api/chat` | チャット補完（デフォルトは NDJSON ストリーミング） |
| Any | `/v1/*` | メインプロキシへの OpenAI 互換パススルー |

```jsonc
// POST http://127.0.0.1:11434/api/chat
{
  "model": "codex",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "think": "medium"  // オプション: false | true | low | medium | high | xhigh
}
```

サポートされているリクエストマッピング：

| Ollama フィールド | アップストリーム OpenAI フィールド |
|--------------|-----------------------|
| `messages[].images` | `content[].image_url` data URLs |
| `tools` | `tools` |
| `think` | `reasoning_effort` |
| `format: "json"` | `response_format: { type: "json_object" }` |
| `format: { ... }` | 厳格な JSON スキーマレスポンス形式 |
| `options.temperature` | `temperature` |
| `options.top_p` | `top_p` |
| `options.num_predict` | `max_tokens` |

---

## モデル

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/v1/models` | モデル一覧の取得（OpenAI 形式、Client Key 利用時は権限で自動フィルタリング） |
| GET | `/v1/models/catalog` | reasoning effort とメタデータを含む完全なモデルカタログ |
| GET | `/v1/models/:id` | 単一モデルの詳細 |
| GET | `/v1/models/:id/info` | モデルの拡張情報 |
| GET | `/v1beta/models` | モデル一覧の取得（Gemini 形式） |
| POST | `/admin/refresh-models` | アップストリームからのモデル情報強制更新 |

モデルカタログのエントリには、トークンのメタデータが含まれる場合があります：

| フィールド | 意味 |
|-------|---------|
| `contextWindow` | 表示およびクライアントの参考用の静的またはバックエンド提供のコンテキストウィンドウ |
| `maxContextWindow` | バックエンドが提供する最大拡張コンテキストウィンドウ（報告された場合） |
| `maxOutputTokens` | 表示およびクライアントの参考用の静的またはバックエンド提供の最大出力トークン |
| `truncationPolicyLimit` | バックエンドが提供する切り捨てポリシー制限（報告された場合） |
| `outputModalities` | サポートされている出力モダリティ（例：`["text"]`、`["text", "image"]`） |

静的カタログ値は `config/models.yaml` で定義されています。アップストリームから同じモデル ID が返された場合、`/backend-api/codex/models` からの動的エントリが優先されます。

---

## クライアントキー管理（Client Keys）

クライアントキー（サブキー）を使用すると、特定の予算、アクセス可能モデル、トークン上限、同時実行数制限、有効期限を持つ個別の API キーを発行できます。

### セルフサービスエンドポイント

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/v1/sub-key/info` | クライアントキーのクォータ、残高、許可モデル、利用状況の照会 |

### 管理者向け操作

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/client-keys` | すべてのクライアントキー（マスク表示）と統計サマリーの一覧表示 |
| POST | `/admin/client-keys` | 新しいクライアントキーの作成（`{ name, key?, expires_at?, max_budget_usd?, max_tokens?, max_concurrency?, allowed_models?, default_tools? }`） |
| PUT | `/admin/client-keys/:id` | クライアントキー設定の更新 |
| POST | `/admin/client-keys/:id/toggle` | キーの有効化 / 無効化切り替え（`active` / `disabled`） |
| POST | `/admin/client-keys/:id/reset-usage` | キーの消費額およびトークンカウンターのリセット |
| DELETE | `/admin/client-keys/:id` | クライアントキーの削除 |

---

## アカウント管理

### CRUD

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/accounts` | 全アカウント一覧、永続化ヘルス状態、フォールバックアップストリーム状態の取得 |
| POST | `/auth/accounts` | 単一アカウントの追加（`{ token?, refreshToken? }`） |
| DELETE | `/auth/accounts/:id` | アカウントの削除 |
| PATCH | `/auth/accounts/:id/label` | ラベルの設定（`{ label }`） |
| PATCH | `/auth/accounts/:id/codex-fingerprint` | TLS フィンガープリントモードの設定（`{ mode: "off" | "session" }`） |

### 一括操作

| メソッド | パス | 説明 |
|--------|------|-------------|
| POST | `/auth/accounts/import` | アカウントの一括インポート（`{ accounts: [{token?, refreshToken?, label?}] }` またはプレーンテキスト） |
| POST | `/auth/accounts/batch-delete` | アカウントの一括削除（`{ ids: [] }`） |
| POST | `/auth/accounts/batch-status` | アカウントの一括有効化 / 無効化（`{ ids: [], status: "active" | "disabled" }`） |

### ヘルスチェック & クォータ

| メソッド | パス | 説明 |
|--------|------|-------------|
| POST | `/auth/accounts/health-check` | アカウントの接続確認（`{ ids?, stagger_ms?, concurrency? }`） |
| POST | `/auth/accounts/:id/refresh` | 単一アカウントのトークンとステータスの更新 |
| GET | `/auth/accounts/:id/quota` | クォータと利用状況の取得 |
| POST | `/auth/accounts/:id/reset-usage` | 利用量カウンターのリセット |
| GET | `/auth/accounts/:id/reset-credits` | Reset Credits 情報の取得 |
| POST | `/auth/accounts/:id/reset-credits/consume` | Reset Credit の消費（`{ redeem_request_id? }`） |

### エクスポート

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/accounts/export` | アカウントのエクスポート（`?ids=a,b&format=minimal|full|csv|token-key|auth-json|sub2api`） |

### Cookies（Cloudflare）

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/accounts/:id/cookies` | 保存されている Cookies の取得 |
| POST | `/auth/accounts/:id/cookies` | Cookies の設定（`{ cookies }`） |
| DELETE | `/auth/accounts/:id/cookies` | Cookies のクリア |

### フォールバックアップストリーム API キー

すべての OAuth アカウントが期限切れ、レート制限中、または利用不可になった場合、プロキシは自動的に設定されたフォールバックアップストリーム API キーにリクエストを転送します。

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/fallback-upstream` | フォールバック設定およびステータスの取得 |
| POST | `/auth/fallback-upstream` | フォールバックアップストリームの設定（`{ baseUrl, apiKey }`） |
| PUT | `/auth/fallback-upstream` | フォールバックアップストリームの更新（`{ baseUrl, apiKey? }`） |
| DELETE | `/auth/fallback-upstream` | フォールバックアップストリームの削除 |

---

## サードパーティ Provider API キー管理

アップストリームプロバイダー（Anthropic、OpenAI、Gemini、OpenRouter、Custom）の API キーを管理します。

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/api-keys` | 設定済み Provider API キーの一覧取得 |
| GET | `/auth/api-keys/catalog` | プロバイダーの事前定義モデルカタログの取得 |
| POST | `/auth/api-keys/models` | アップストリームプロバイダーから利用可能なモデル一覧を取得 |
| GET | `/auth/api-keys/export` | 再インポート用 API キーのエクスポート |
| POST | `/auth/api-keys/import` | Provider API キーの一括インポート（`{ keys: [] }`） |
| POST | `/auth/api-keys` | 単一 Provider キーバインディングの追加（`{ provider, models, apiKey, baseUrl?, label?, capabilities?, wire? }`） |
| POST | `/auth/api-keys/batch-delete` | Provider API キーの一括削除（`{ ids: [] }`） |
| DELETE | `/auth/api-keys/:id` | Provider API キーの削除 |
| PATCH | `/auth/api-keys/:id/label` | ラベルの変更（`{ label }`） |
| PATCH | `/auth/api-keys/:id/status` | ステータスの変更（`{ status: "active" | "disabled" }`） |

---

## OAuth & ログイン

| メソッド | パス | 説明 |
|--------|------|-------------|
| POST | `/auth/login-start` | OAuth 開始 → `{ authUrl, state }` |
| GET | `/auth/login` | Auth0 への 302 リダイレクト |
| POST | `/auth/code-relay` | OAuth 認証コードの交換（`{ callbackUrl }`） |
| GET | `/auth/callback` | OAuth コールバックハンドラー |
| POST | `/auth/device-login` | デバイスコードフローの開始 |
| GET | `/auth/device-poll/:deviceCode` | デバイス承認ステータスのポーリング |
| POST | `/auth/import-cli` | Codex CLI の `auth.json` からインポート |
| POST | `/auth/token` | 手動トークン送信 |
| GET | `/auth/status` | 認証状態 + アカウントプール概要 |
| POST | `/auth/logout` | 全アカウントのログアウト・クリア |

---

## プロキシプール管理

### CRUD

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/api/proxies` | プロキシ一覧（ヘルス状態と割り当てを含む） |
| POST | `/api/proxies` | プロキシの追加（`{ url }` または `{ host, port, username, password }`） |
| PUT | `/api/proxies/:id` | プロキシの更新 |
| DELETE | `/api/proxies/:id` | プロキシの削除 |

### ヘルスチェック & 制御

| メソッド | パス | 説明 |
|--------|------|-------------|
| POST | `/api/proxies/:id/check` | 単一プロキシのヘルスチェック |
| POST | `/api/proxies/check-all` | 全プロキシのヘルスチェック |
| POST | `/api/proxies/:id/enable` | プロキシの有効化 |
| POST | `/api/proxies/:id/disable` | プロキシの無効化 |

### 割り当て（アカウント ↔ プロキシ）

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/api/proxies/assignments` | すべての割り当て関係の一覧 |
| POST | `/api/proxies/assign` | アカウントへのプロキシ割り当て（`{ accountId, proxyId }`） |
| DELETE | `/api/proxies/assign/:accountId` | 割り当ての解除 |
| POST | `/api/proxies/assign-bulk` | 一括割り当て（`{ assignments: [] }`） |
| POST | `/api/proxies/assign-rule` | ルールによる自動割り当て（`{ rule: "round-robin", ... }`） |

### インポート / エクスポート

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/api/proxies/export` | YAML としてエクスポート |
| POST | `/api/proxies/import` | YAML またはプレーンテキスト（`host:port:user:pass`）のインポート |
| GET | `/api/proxies/assignments/export` | 割り当て関係のエクスポート |
| POST | `/api/proxies/assignments/import` | 割り当てインポートのプレビュー |
| POST | `/api/proxies/assignments/apply` | 割り当てインポートの適用 |

### 設定

| メソッド | パス | 説明 |
|--------|------|-------------|
| PUT | `/api/proxies/settings` | ヘルスチェック間隔の更新 |

---

## 管理 & 設定

### 一般設定

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/general-settings` | サーバー / TLS / モデル / ログの全設定取得 |
| POST | `/admin/general-settings` | 設定の更新（`restart_required` フラグを返却） |
| GET | `/admin/settings` | マスタープロキシ API キーの取得 |
| POST | `/admin/settings` | マスタープロキシ API キーの設定 |
| GET | `/admin/rotation-settings` | ローテーション戦略の取得 |
| POST | `/admin/rotation-settings` | ローテーション戦略の設定（`least_used` | `round_robin` | `sticky`） |
| GET | `/admin/quota-settings` | クォータスキップ & 更新設定の取得 |
| POST | `/admin/quota-settings` | クォータスキップ & 更新設定の変更 |
| GET | `/admin/ollama-settings` | Ollama ブリッジ設定および実行状態の取得 |
| POST | `/admin/ollama-settings` | Ollama ブリッジ設定の保存と再起動 |
| GET | `/admin/ollama-status` | Ollama ブリッジの実行状態取得 |

### 診断

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/health` | ヘルスプローブ → `{ status, authenticated, pool, uptime_seconds }` |
| POST | `/admin/test-connection` | 完全な接続性診断（サーバー、アカウント、トランスポート、アップストリーム） |
| GET | `/debug/fingerprint` | TLS フィンガープリント設定（localhost のみ） |
| GET | `/debug/diagnostics` | システム診断情報とファイルパス（localhost のみ） |
| GET | `/debug/models` | モデルストアの内部状態 |

### リクエストログ

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/logs` | 記録されたリクエストログの一覧（`?limit=&offset=&direction=&search=`） |
| GET | `/admin/logs/state` | ログストアの状態（`enabled`, `paused`, `capacity`） |
| POST | `/admin/logs/state` | ログ収集状態の更新（`{ enabled?, paused? }`） |
| POST | `/admin/logs/clear` | メモリ上の全リクエストログを消去 |
| GET | `/admin/logs/:id` | 単一ログエントリの詳細取得 |

### エラーログ

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/error-logs` | グループ化されたエラーログの取得 |
| GET | `/admin/error-logs/raw` | 生のエラーログエントリ一覧（`?limit=`） |
| GET | `/admin/error-logs/count` | エラー総数および未読エラー数の取得 |
| POST | `/admin/error-logs/seen` | エラーログを既読としてマーク |
| DELETE | `/admin/error-logs` | エラーログのクリア |
| POST | `/admin/error-logs/report` | クライアントエラーの報告（`{ source, error: { name, message, stack }, context? }`） |

### 公式 Codex App Server ブリッジ

ローカルの公式 `codex app-server` インスタンスへのオプションのブリッジ。Chrome/ブラウザプラグインなどの公式 Codex app プラグイン機能を利用するために使用されます。デフォルトは無効（`official_agent.enabled: false`）。専用の `official_agent.api_key` が必須です。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | `/official-agent/apps` | `app/list` から公式 Codex apps/connectors を一覧表示 |
| POST | `/official-agent/threads` | app-server スレッドの作成（`{ model?, cwd? }`） |
| POST | `/official-agent/threads/:threadId/turns` | ターンを開始し、app-server 通知を SSE でストリーミング |

### アップデート

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/update-status` | 利用可能なアップデートの確認 |
| POST | `/admin/check-update` | アップデート確認のトリガー |
| POST | `/admin/apply-update` | 自動アップデートの適用（SSE 進捗ストリーム） |

### 利用統計

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/admin/usage-stats/summary` | アカウント / モデル / Client Key ごとの累積利用量 |
| GET | `/admin/usage-stats/history` | 時系列データ（`?granularity=raw|five_min|hourly|daily&hours=24|all`） |

### クォータ警告

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/auth/quota/warnings` | 現在アクティブなクォータ警告 |

`quota.skip_exhausted` を有効にすると、アカウント取得時にキャッシュされたクォータで `rate_limit.limit_reached === true`、`secondary_rate_limit.limit_reached === true`、または `code_review_rate_limit.limit_reached === true` となっている active アカウントが除外されます。これはセッションアフィニティの前に実行されるため、`preferredEntryId` によって枯渇したアカウントにリクエストが固定されるのを防ぎます。`used_percent=99` などの上限に近い状態では、アップストリームが `limit_reached` をマークするまでスキップされません。429 が返されると、そのアカウントは `rate_limited` バックオフに入り、別のアカウントに切り替わります。

---

## ダッシュボード認証

| メソッド | パス | 説明 |
|--------|------|-------------|
| POST | `/auth/dashboard-login` | パスワードログイン → セッション cookie を設定（レート制限: 5回/分） |
| POST | `/auth/dashboard-logout` | ログアウト |
| GET | `/auth/dashboard-status` | ログインが必要かどうかの確認 |

---

## エラー形式

各プロトコルはそれぞれのネイティブ形式でエラーを返します：

| プロトコル | 形式 |
|----------|--------|
| OpenAI | `{ error: { message, type, code, param } }` |
| Anthropic | `{ type: "error", error: { type, message } }` |
| Gemini | `{ error: { code, message, status } }` |
| Responses | `{ type: "error", error: { type, code, message } }` |
| Admin | `{ error: "..." }` |

一般的な HTTP ステータスコード：`401`（未認証）、`429`（レート制限）、`503`（利用可能アカウントなし）。
