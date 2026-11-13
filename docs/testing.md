# テストとカバレッジ

CI は PR と main の全変更で動作します。パスによる省略やセルフホストランナーへの切り替えはありません。`required-ci` は API、Web、データ抽出、E2E、Linux 本番イメージの各ジョブがすべて成功した場合だけ成功します。

## 計測する範囲

| レポート | 計測 | 合格基準 |
| --- | --- | --- |
| Go アプリケーション全体 | `go test -race -coverprofile`、API と各コマンド | statements 80%以上 |
| インポーター | 同じ Go プロファイルの対象コマンド | statements 80%以上 |
| Web | Vitest + V8、アプリケーションコード | lines 80%以上 |
| PDF 抽出器 | coverage.py、テストコードを除く scripts | statements 80%以上 |
| 実 MySQL 結合テスト | 結合テストだけの Go 実行範囲 | 実測値を報告 |
| ブラウザー E2E | 実際の画面操作で実行されたソースの範囲 | 実測値を報告 |

単体テストの合算値と結合・E2E 単独の実行範囲は別の指標です。後者の値を単体カバレッジと合算したり、操作が通っただけで100%と見なしたりしません。行カバレッジだけで全分岐の正しさは保証されないため、未認証・状態不一致・他ユーザー・不正パス・失効・障害時のケースもテストします。

Go の実 MySQL テストでは CI 専用の MySQL 8.4 と架空ユーザーを使い、OAuth PKCE、認証が必要な資料・企業情報、ユーザー別ブックマーク、別端末からの共有、ログアウトと失効を確認します。本番の認証サービスや実際の配布資料は使いません。

## PR に表示するレポート

Taskly と同じ方式の bounded JSON レポートと更新型 PR コメントを使います。同一リポジトリの PR は CI の権限を分けた最終ジョブ、fork は既定ブランチの `workflow_run` でコメントします。コメント処理は PR のコードを checkout・実行せず、PR 番号・リポジトリ・現在の head SHA を照合します。実行プロファイルと集計値は Actions artifact に保存し、原本や実データは保存しません。

## ローカルで再現

```sh
go test -race -coverprofile=/tmp/guidance-go.out ./...
go tool cover -func=/tmp/guidance-go.out
go vet ./...
npm --prefix apps/web run typecheck
npm --prefix apps/web run test:coverage
npm --prefix apps/web run build
node --test .github/scripts/coverage-summary.test.mjs deploy/r2/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```

実 MySQL テストは使い捨ての専用 DB を用意し、`MYSQL_TEST_DSN` を渡して `go test -race -run '^TestMySQLIntegration$' ./internal/server` を実行します。テストはスキーマを準備し、架空データを書き込みます。稼働データを含む DB の DSN を使わないでください。

ブラウザー E2E は `MYSQL_DSN` に別の使い捨て DB を指定し、Chromium をインストールしてから `node scripts/e2e-run.mjs` を実行します。スクリプトが架空データの取り込み、ローカル OAuth サーバー、Go API、Next.js 静的本番ビルドの配信を準備します。詳細な出力先はスクリプトと `apps/web/tests` を参照してください。
