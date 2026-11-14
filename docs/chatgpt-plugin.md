# ChatGPTプラグイン

このサービスのGo APIへMCPで接続し、ログインした本人の企業検索・指定企業・スケジュール・気になる企業・やることをチャットから扱います。サーバーは既存の本番環境で運用し、Next.jsの静的画面や認証サービスの配置を変更しません。プラグイン専用の対話画面は含みません。

## パッケージ

ソースは `plugins/taskly-nnct-corp-guidance/` にあります。

- `plugin.json`: Agent Plugins 1.0の識別子・表示名・説明。
- `mcp.json`: リモートMCPとOAuth接続の設定。
- `skills/guidance-workflow/SKILL.md`: 検索・参照と、明示的な依頼に基づく更新の手順。
- `assets/taskly-icon.png`: 既存のTasklyアイコン。画面の [apple-touch-icon](https://cdn.taskly.iy0306.com/assets/apple-touch-icon.png) と同じ画像を使用します。

パッケージには資料・個人情報・トークン・クライアントシークレットを含めません。配布資料は引き続き非公開R2で管理します。元のWeb画面のオフライン保存は、ChatGPTからのMCP利用には適用しません。

## 接続と操作

接続先は `https://api.nnct-corp-guidance-2026.taskly.iy0306.com/mcp`、transportはStreamable HTTPです。OAuthは既存のtaskly-authを使用し、公開クライアント `nnct-guidance-chatgpt` は `tokenEndpointAuthMethod: none` で接続します。クライアントシークレットをプラグインへ設定しません。

プラグインは非公開でアカウントへ保存し、ホストのOAuth接続画面から認証します。パッケージを保存しただけでは、サーバーの配備・利用者の認証・ツールの利用確認は完了しません。公開ディレクトリへの申請やワークスペース共有は別の操作です。

接続時の基本・既定権限は `guidance:read` です。気になる企業の変更には `guidance:bookmarks:write`、やることの変更には `guidance:tasks:write` を追加で使います。認可はホストの接続画面を通し、Cookieやトークンをチャットへ貼り付けません。

参照と書き込みの権限を分け、気になる企業ややることの更新は利用者が明示的に依頼した場合だけ実行します。アンケートと指定企業の見学が連動した場合は、サーバーが返した関連項目の結果をそのまま確認し、追加の更新を推測しません。詳細は [Taskly連携](taskly-integration.md) と [テストとカバレッジ](testing.md) を参照してください。

## ツール

| ツール                    | 用途                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `get_profile`             | 検証済みの本人ID。名前・メールアドレスは返さない                              |
| `search_companies`        | 名前・業種・時間帯などで検索。`favorites_only=true`で本人の気になる企業に限定 |
| `get_company`             | 企業情報と画面・マップへのリンク                                              |
| `get_my_guidance`         | 開催情報・予定・本人の指定企業。完了状態は含めない                            |
| `list_documents`          | 資料のメタデータと画面への案内リンク。本文・ファイル・署名付きURLは返さない   |
| `get_home_tasks`          | 本人のやることの完了状態                                                      |
| `set_favorite`            | `company_id`と`favorite`で気になるを追加・解除                                |
| `set_home_task_completed` | `task_id`と`completed`で完了・取り消し。関連タスクも返す                      |

すべてのツールに `guidance:read` が必要です。2つの変更ツールは対応する追加スコープも要求します。指定企業の参照と実際の完了状態、チェックの更新とフォームの送信は別の操作です。

## 検証して保存する

MCPの実装と公開メタデータ、未認証時の拒否、OAuth後の実際のツール一覧と入力スキーマを確認してから接続設定を確定します。認証確認のためだけに保存・完了更新のツールを実行しません。

パッケージのJSON・YAML、スキーマ、短い説明の文字数、参照アイコン、格納パス、秘密情報の混入を確認します。ZIPを作る場合はパッケージの外側へ出力し、単一のプラグインだけを含めます。依存ディレクトリ・Git管理情報・環境変数ファイル・symlink・実資料は含めません。最終ZIPの内容を確認し、ソースを変更したら作り直して再確認します。

公開のAgent Plugins 1.0 MCPスキーマはtransportだけを定義し、サーバーのOpenAI拡張を受け付けないため、transport部分を取り出して検証します。`extensions.com.openai.auth` は別にOAuthの型・公開クライアント・基本/既定スコープを検証し、認証設定を削除してスキーマを通すことはしません。保存時はPlugin Creatorのコンポーネント診断も確認します。

脆弱性や非公開情報の報告先は [セキュリティ方針](../SECURITY.md) を参照してください。
