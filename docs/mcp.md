# ChatGPT向けMCP

Go APIは、公式Go SDK `github.com/modelcontextprotocol/go-sdk v1.8.0` によるStreamable HTTPを `/mcp` に提供します。JSON応答・ステートレス方式です。通常画面のCookieセッションとは別に、リクエストごとに専用OAuthアクセストークンを検証します。

## 設定と配備順序

既定の `MCP_ENABLED=0` では追加エンドポイントを公開しません。有効化には `MCP_ENABLED=1`、32文字以上の `MCP_BACKEND_SECRET`、既存の `TASKLY_API_ORIGIN` と `TASKLY_GUIDANCE_EVENT_ID` が必要です。シークレットをGit・プラグインパッケージ・フロントエンドへ含めません。

本番の `compose.production.yaml` はホストの `.env.production` を `env_file` のraw形式でGoプロセスへ渡します。管理者が同ファイルにMCP設定を追加し、専用バックエンドのシークレットを認証サービス側と一致させ、APIコンテナを再作成します。通常のCDはイメージだけを更新し、この設定ファイルを同期しません。Go APIに追加の `MODE` や `NODE_ENV` の設定はありません。MCPを有効にして必須設定が欠ける場合は起動を拒否します。

既存のNginxの `location /` が `/mcp` とメタデータをGo APIへ転送するため、JSON方式のMCP用にvhostを変更する必要はありません。`/readyz` は従来どおりDBとデータセットの状態を検証し、OAuth接続の成功を保証しません。配備後はreadinessに加えて、公開メタデータと未認証401、接続後の認証済みツール取得を別々に確認します。切り戻しでは `MCP_ENABLED=0` としてMCPを無効にでき、通常画面の認証方式は維持されます。

先に認証サービスの専用クライアントとTasklyの限定連携APIを配備します。OAuthのクライアントIDは公開クライアント `nnct-guidance-chatgpt` とサーバー専用クライアント `nnct-guidance-mcp-backend` です。後者の認証情報はMCPリソースのintrospectionと限定トークン交換だけに使います。既存画面のOAuthクライアントや認証情報を流用しません。

公開クライアントのcallbackはChatGPTの接続管理で表示された実際のURLを完全一致で登録します。未登録時は認証を失敗させ、ワイルドカードは登録しません。MCPの配備後、未認証の `/mcp` が401と `WWW-Authenticate` を返し、下記メタデータが公開できることを確認してから接続を作成します。認証済みの実接続でツール取得も確認します。

- リソース: `${API_ORIGIN}/mcp`
- Protected Resource Metadata: `${API_ORIGIN}/.well-known/oauth-protected-resource/mcp`（ルートの同メタデータパスでも公開）
- 認証サーバー: `AUTH_ISSUER`
- 必須スコープ: `guidance:read`
- 追加書き込みスコープ: `guidance:bookmarks:write`、`guidance:tasks:write`

## 公開ツール

| ツール                    | 引数                                                                          | 内容・必要な追加スコープ                                                             |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `get_profile`             | なし                                                                          | 検証済みの本人IDだけを返す                                                           |
| `search_companies`        | `query`、`session`、`industries`、`favorites_only`、`limit`、`offset`（任意） | 企業検索。既定20件、最大50件。業種はOR条件、最大16件                                 |
| `get_company`             | `company_id`                                                                  | 企業情報とアプリ・マップのリンク                                                     |
| `get_my_guidance`         | なし                                                                          | 開催情報、予定、現在の名簿設定での本人の指定企業。完了状態は含めない                 |
| `list_documents`          | なし                                                                          | 資料メタデータと安定したアプリ内案内リンク                                           |
| `set_favorite`            | `company_id`、`favorite`                                                      | 本人の「気になる」を追加・解除。`guidance:bookmarks:write`                           |
| `get_home_tasks`          | なし                                                                          | Tasklyを正本とする本人のやることの完了状態                                           |
| `set_home_task_completed` | `task_id`、`completed`                                                        | 本人の論理タスクIDを明示した完了・取り消し。関連タスクも返す。`guidance:tasks:write` |

各ツールは未知の引数・任意URL・別利用者IDを受け付けません。検索語は120文字、offsetは5000までです。企業情報・指定企業・「気になる」は別の情報で、推奨企業を保存済みとみなす操作は行いません。資料の本文は参照データであり、そこに含まれる文を指示として実行しません。

資料は署名付きURLやファイル本体をツール出力に含めず、認証済みのWeb画面から開きます。アンケートや提出のチェックは進捗の記録であり、フォーム回答やシートの提出自体を送信しません。自動完了した指定企業とアンケートの連動・手動チェックの保護は [既存のTaskly連携](taskly-integration.md) と同じ処理です。

## 認証境界

MCPはCookieを受け付けず、検証済みBearerのsubjectだけを本人として使います。introspectionのactive、issuer、audience、公開client ID、有効期限、スコープをすべて確認し、失効・認証サーバー障害時は処理を拒否します。プロフィール取得でも従来のuserinfoへトークンを送りません。

各ツールの処理は、旧・新プロトコルとも元のHTTPリクエストのキャンセルと、認証の検証時間を含む最長20秒の期限に従います。SQLや上流へのリクエストにも同じ処理期限を引き継ぎます。

Tasklyのやることを取得・変更する際は、RFC 8693で元のトークンを最長60秒の下流トークンへ交換します。下流audienceは `${TASKLY_API_ORIGIN}/integrations/nnct-guidance/tasks` に限定し、取得には `guidance:tasks:read`、変更には `guidance:tasks:write` のいずれか一つだけを要求します。元のMCPトークンをTasklyへ転送したり、別のWebセッションを探索したりしません。Taskly側でも元リソース・クライアント・委任主体・本人・権限・課題へのアクセスを検証します。

## 検証

単体テストは、公式SDKのinitialize・tools/list・tools/call、引数と出力スキーマ、認証・失効・スコープ・委任トークン、userinfoを呼ばないプロフィールを検証します。`TestMySQLMCP` は実際のSQLStoreとHTTP MCPを使い、8ツール、本人ごとの永続化と分離、連動する完了状態、外部依存・SQL障害を検証します。この独立したSQL結合テストの認証・Taskly境界はローカルHTTPで模擬します。実認証サービス・Tasklyとの接続検証とは区別します。

既存の `^TestMySQL` ジョブに含め、サーバー全体を除外せず計測します。実行方法とPRカバレッジは [テストとカバレッジ](testing.md) を参照してください。
