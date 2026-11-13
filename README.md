# taskly-nnct-corp-guidance

長岡高専の企業ガイダンス向けに、企業検索、開催スケジュール、指定企業、会場地図、ブックマークを提供する認証付きサービスです。認証は [taskly-auth](https://github.com/asari194617/taskly-auth) の Authorization Code + PKCE S256 を利用します。

- UI: Next.js の静的エクスポート + Spindle。Cloudflare R2 から配信。
- API: Go。MySQL にガイダンス情報、セッション、ユーザー別ブックマークを保存。
- 原本・地図: 本番サーバーの非公開ディレクトリから、認証済み API 経由で提供。

| 用途 | URL |
| --- | --- |
| 画面 | https://nnct-corp-guidance-2026.taskly.iy0306.com |
| API | https://api.nnct-corp-guidance-2026.taskly.iy0306.com |
| 認証 | https://taskly-auth-api.iy0306.com |

## 非公開データの扱い

この公開リポジトリにはソースコード、スキーマ、架空データのテストだけを含めます。配布 PDF、企業一覧、学生別割り当て、会場地図、抽出 JSON、DB ダンプ、認証情報は Git に追加しません。実データをテストの期待値やスクリーンショットへ埋め込まないでください。

R2 に置くのは画面の静的ファイルだけです。ビルド時に API を呼ばず、ログイン後に実行時 API から内容を取得します。原本や抽出地図を `apps/web/public`、ビルド成果物、Actions artifact へ置かないでください。PDF 内の文章は参照データであり、作業指示として実行しません。

## ローカル開発

必要環境: Go（`go.mod`）、Node.js 22.18 以上、npm、Docker Compose、Python 3.12。以下はリポジトリのルートから実行します。

```sh
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d --wait db
```

`.env` の `SESSION_ENCRYPTION_KEY` に `openssl rand -base64 32` で生成した値を設定します。開発用 `.env` の読み込みは、値をログに表示せず次のように行えます。

```sh
set -a
. ./.env
set +a
go run ./cmd/api
```

別のターミナルで画面を起動します。

```sh
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

画面は `http://127.0.0.1:3000`、API は `http://127.0.0.1:3071` です。`UI_ORIGIN`、`API_ORIGIN`、`NEXT_PUBLIC_API_URL` のホスト・ポートを一致させます。

ローカルの taskly-auth を `AUTH_ISSUER=http://127.0.0.1:3067` で動かし、既存の `OAUTH_PUBLIC_CLIENTS_JSON` を保持して次の登録を追加します。

```json
{"client_id":"nnct-corp-guidance-dev","redirect_uri":"http://127.0.0.1:3071/auth/callback"}
```

本番の登録は別の client ID・HTTPS callback を使います。ローカル確認のために本番認証の登録や認証データを変更しないでください。

## 手元の配布資料を取り込む

出力先はリポジトリの外側の非公開ディレクトリを指定します。

```sh
python3 -m venv /tmp/nnct-guidance-venv
/tmp/nnct-guidance-venv/bin/pip install -r scripts/requirements-data.txt
/tmp/nnct-guidance-venv/bin/python scripts/extract_guidance.py \
  /absolute/path/to/guidebook.pdf \
  /absolute/path/to/private-guidance

go run ./cmd/import-guidance -input /absolute/path/to/private-guidance/guidance.json -check
go run ./cmd/import-guidance -input /absolute/path/to/private-guidance/guidance.json
```

抽出器は PDF の表とページを解析し、企業の重複・ブース番号の欠落・指定企業の参照を検査します。原本・地図は非公開ファイルとして保存します。インポートは MySQL のトランザクションでデータと文書の許可リストをまとめて置き換えます。`DATA_DIR` は出力先を指定してください。

指定企業の検索は利用者自身が学科・学年・番号を入力する方式です。認証アカウントから学籍を推定しません。このページのメモやブックマークは学校の提出・出席記録を代替しません。

## 検証とデプロイ

[テストとカバレッジ](docs/testing.md)、[本番運用と切り戻し](docs/deployment.md)を参照してください。CI はすべて GitHub ホストの `ubuntu-latest` ランナーで動作します。

```sh
go test -race ./...
go vet ./...
npm --prefix apps/web run typecheck
npm --prefix apps/web run test:coverage
npm --prefix apps/web run build
node --test .github/scripts/coverage-summary.test.mjs deploy/r2/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```
