# taskly-nnct-corp-guidance

長岡高専の企業ガイダンスで、企業探し・会場での移動・見学や回答の進捗確認を支援する認証付きサービスです。[画面を開く](https://nnct-corp-guidance-2026.taskly.iy0306.com)。

## 主な機能

- 企業検索、おすすめ、ユーザー別の「気になる」と指定企業。
- 開催スケジュール、操作できる会場マップ、配布資料の閲覧。
- Tasklyと共有するやることの完了状態と、取得済み情報のオフライン参照。

## 構成

- UI: Next.jsの静的エクスポート + SpindleをCloudflare R2から配信。
- API: Go + MySQL。[taskly-auth](https://github.com/asari194617/taskly-auth)のAuthorization Code + PKCEで認証。
- 資料: UIと分けた非公開R2から、認証後に発行する一時URLで取得。

実資料・個人情報・認証情報はGitへ含めません。開発・テストには架空データを使用します。

## ローカル開発

必要環境・認証設定・起動・資料の取り込みは [ローカル開発手順](docs/development.md)、変更とPRの進め方は [開発への参加](CONTRIBUTING.md) を参照してください。

## 文書

| 内容               | 文書                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| 画面と利用者設定   | [機能の詳細](docs/features.md)                                              |
| Tasklyのやること   | [連携設定](docs/taskly-integration.md)                                      |
| 品質チェック       | [lint・format](docs/code-quality.md)、[テストとカバレッジ](docs/testing.md) |
| 本番環境           | [配備・切り戻し](docs/deployment.md)、[非公開R2](docs/private-r2.md)        |
| 通信できない場合   | [オフライン参照](docs/offline.md)                                           |
| 脆弱性の非公開報告 | [セキュリティ方針](SECURITY.md)                                             |
