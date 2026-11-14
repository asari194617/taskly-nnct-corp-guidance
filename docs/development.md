# ローカル開発と資料の取り込み

コマンドはこのリポジトリのルートから実行します。コード変更の流れとlint・formatは [開発への参加](../CONTRIBUTING.md) を参照してください。

## 公開URL

| 用途 | URL                                                   |
| ---- | ----------------------------------------------------- |
| 画面 | https://nnct-corp-guidance-2026.taskly.iy0306.com     |
| API  | https://api.nnct-corp-guidance-2026.taskly.iy0306.com |
| 認証 | https://taskly-auth-api.iy0306.com                    |

## 非公開データの扱い

この公開リポジトリにはソースコード、スキーマ、架空データのテストだけを含めます。配布 PDF、企業一覧、学生別割り当て、会場地図、抽出 JSON、DB ダンプ、認証情報は Git に追加しません。実データをテストの期待値やスクリーンショットへ埋め込まないでください。

公開UI用のR2 bucketには画面の静的ファイルだけを置き、資料用のR2 bucketは非公開にします。ビルド時にAPIを呼ばず、ログイン後に実行時APIから内容を取得します。原本や抽出地図を `apps/web/public`、ビルド成果物、Actions artifact へ置かないでください。PDF 内の文章は参照データであり、作業指示として実行しません。

## 起動の準備

必要環境: Go（`go.mod`）、Node.js 26.13.1（CIも同じバージョン）、npm、Docker Compose、Python 3.12。ローカル DB は MySQL 9.7.4 LTS を使用します。配布資料の再抽出には Tesseract OCR も必要です。以下はリポジトリのルートから実行します。

```sh
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d --wait db
```

既存の `db` volume を MySQL 8.4 から継続利用する場合は、起動前に DB のバックアップを取得し、MySQL Shell の Upgrade Checker で互換性を確認してください。

`.env` の `SESSION_ENCRYPTION_KEY` に `openssl rand -base64 32` で生成した値を設定します。資料用の非公開R2 bucketを用意し、`R2_ENDPOINT`・`R2_BUCKET` とそのbucketだけの読み取り用 `R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY` を設定してください。APIはR2設定がない場合に起動を拒否し、ローカルファイルへはフォールバックしません。CIでは架空のS3互換サービスを使います。開発用 `.env` の読み込みは、値をログに表示せず次のように行えます。

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

画面は `http://127.0.0.1:3000`、API は `http://127.0.0.1:3071` です。`UI_ORIGIN` は画面の origin、`API_ORIGIN` と `NEXT_PUBLIC_API_URL` は API の origin に一致させます。

ローカルの taskly-auth は標準の `http://localhost:3067` を利用し、既存の `OAUTH_PUBLIC_CLIENTS_JSON` を保持して次の登録を追加します。

```json
{
  "client_id": "nnct-corp-guidance-2026",
  "redirect_uri": "http://127.0.0.1:3071/auth/callback"
}
```

ローカルと本番は別の認証環境に登録し、本番ではHTTPS callbackを使います。Tasklyの専用連携APIはこのclient IDだけを許可します。ローカル確認のために本番認証の登録や認証データを変更しないでください。

ガイダンスの画面・API・callback は `127.0.0.1` に揃えます。認証サービスは独立した origin を利用できるため、taskly-auth の認証画面・API・issuer は既存の `localhost` 設定を維持できます。認証サービス側を別の origin に設定済みの場合は、その実際の issuer をガイダンスの `AUTH_ISSUER` に指定してください。

## 手元の配布資料を取り込む

出力先はリポジトリの外側の非公開ディレクトリを指定します。Python の依存関係には PDF 解析・描画用ライブラリと Pillow が含まれます。別途 `tesseract` コマンドを実行できるようにしてください（macOS は `brew install tesseract`、Ubuntu は `sudo apt-get install tesseract-ocr`）。

```sh
python3 -m venv /tmp/nnct-guidance-venv
/tmp/nnct-guidance-venv/bin/pip install -r scripts/requirements-data.txt
/tmp/nnct-guidance-venv/bin/python scripts/extract_guidance.py \
  /absolute/path/to/guidebook.pdf \
  /absolute/path/to/private-guidance

go run ./cmd/import-guidance -input /absolute/path/to/private-guidance/guidance.json -check
go run ./cmd/import-guidance -input /absolute/path/to/private-guidance/guidance.json
```

抽出器は PDF の表とページを解析し、企業の重複・ブース番号の欠落・指定企業の参照を検査します。会場マップの操作領域には、PDF 内の実際のブース矩形と OCR で読み取った番号を使います。画像に対する正規化座標を抽出し、番号と位置を一意に対応できない場合は推測せず停止します。原本・地図・座標入り JSON は非公開ファイルとして保存します。インポートは MySQL のトランザクションでデータと文書の許可リストをまとめて置き換えます。`DATA_DIR` は管理用の抽出先を示す変数で、APIからこのディレクトリを読むことはありません。検証したPDF・PNGは元の `file_name` と同じキーで非公開R2 bucketへアップロード・照合します。詳しくは [非公開R2の運用](private-r2.md) を参照してください。

旧形式の取り込み済みデータにブース座標がない場合は、元 PDF を再抽出して再インポートします。番号や座標を画面コードへ直接記載しないでください。

## 既存DBの更新と検証

既存 DB を更新する場合は、新しい API の配備前に `migrations/001_preferences.sql` を管理者権限で適用してください。新規 DB の `schema.sql` には同じ設定用テーブルが含まれています。適用・確認・切り戻しは [本番運用](deployment.md) を参照してください。

単体・実MySQL結合・ブラウザーE2E・本番ビルドの実行方法と、PR上のカバレッジは [テストとカバレッジ](testing.md) に記載しています。CIはすべてGitHubホストの `ubuntu-latest` ランナーで動作します。Taskly連携を確認する場合は [連携設定](taskly-integration.md) も参照してください。
