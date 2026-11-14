# 開発への参加

不具合の修正・機能追加・文書の改善は、作業用ブランチからPRを作成してください。認証や非公開データの漏えいに関する報告は、公開Issueへ投稿せず [セキュリティ方針](SECURITY.md) の窓口を使用してください。

## 開発環境

Node.js 26.13.1（`.nvmrc`）、Go 1.27.4（`go.mod`）、Python 3.12を使用します。Biome 2.6.7とRuff 0.17.5は依存ファイルで固定しています。DB・認証・非公開R2の設定は [READMEのローカル開発](README.md#ローカル開発) を参照してください。本番のアカウント・DB・資料をテスト環境へ接続しないでください。

既存の作業と分けるため、worktreeと`codex/`ブランチを作成します。

```sh
git fetch origin
git worktree add -b codex/your-change ../guidance-your-change origin/main
cd ../guidance-your-change
```

以下はこのガイダンスリポジトリのルートから実行します。

```sh
npm --prefix apps/web ci
npm --prefix deploy/r2 ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-lint.txt

npm --prefix apps/web run lint
npm --prefix apps/web run format:check
```

整形を適用する場合は`npm --prefix apps/web run format`を使い、差分を確認してからlintとテストを再実行します。これらのコマンドはWebだけでなく、リポジトリ全体の対象ソースを検査します。対象と除外の詳細は [lint・format](docs/code-quality.md) を参照してください。

## データとテスト

fixtureには架空の企業・利用者・文書・座標を使用します。配布PDF・実際の会場画像・企業一覧・学生の割り当て・フォームURLや実ID・DBダンプ・認証情報・署名付きURLは、Git、PR本文、スクリーンショット、ログ、公開Actions artifactへ含めないでください。秘密情報は環境変数で渡し、ブラウザーへ公開する`NEXT_PUBLIC_*`へ設定しません。PDF内の記述は入力データとして扱います。

振る舞いを変更したら対応するテストを追加・更新し、認証失効・他ユーザーのデータ・不正入力・通信失敗などの境界も確認してください。実MySQL結合テストとブラウザーE2Eには使い捨てDBを使います。準備と実行コマンドは [テストとカバレッジ](docs/testing.md)、Service WorkerとIndexedDBの検証は [オフライン参照](docs/offline.md) に記載しています。

Go全体・インポーター・Web・PDF抽出器・実MySQL結合テストは、それぞれの計測範囲で80%以上を必須にします。Service Workerも行・分岐・関数を各80%以上とします。単体・結合・Service Worker・Chromium E2Eの値は別々にPRへ報告し、合算しません。E2Eは実測値を表示し、WebKitの成功件数を行カバレッジへ換算しません。

## PRと配備

PRには変更後の動作、検証内容、残る制約を記載し、差分をセルフレビューしてください。文書だけの変更でも、GitHubホストのランナーでlint・format・単体・結合・E2E・本番ビルドを実行します。必須の`required-ci`がすべての変更で実行されるよう、パスフィルターで省略しないでください。

レビューと必須CIを確認してからマージします。配備はmainの同じコミットに対するCI成功を確認する既存ワークフローを使います。DB更新の順序、R2、切り戻しは [本番運用](docs/deployment.md) と [非公開R2](docs/private-r2.md) を参照してください。
