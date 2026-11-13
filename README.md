# taskly-nnct-corp-guidance

長岡高専の企業ガイダンス向けに、企業検索、開催スケジュール、指定企業、会場地図、ブックマークを提供する認証付きサービスです。認証は [taskly-auth](https://github.com/asari194617/taskly-auth) の Authorization Code + PKCE S256 を利用します。

- UI: Next.js の静的エクスポート + Spindle。Cloudflare R2 から配信。
- API: Go。MySQL にガイダンス情報、セッション、ユーザー別ブックマーク・名簿番号設定を保存。
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

必要環境: Go（`go.mod`）、Node.js 22.18 以上、npm、Docker Compose、Python 3.12。配布資料の再抽出には Tesseract OCR も必要です。以下はリポジトリのルートから実行します。

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

画面は `http://127.0.0.1:3000`、API は `http://127.0.0.1:3071` です。`UI_ORIGIN` は画面の origin、`API_ORIGIN` と `NEXT_PUBLIC_API_URL` は API の origin に一致させます。

ローカルの taskly-auth は標準の `http://localhost:3067` を利用し、既存の `OAUTH_PUBLIC_CLIENTS_JSON` を保持して次の登録を追加します。

```json
{"client_id":"nnct-corp-guidance-dev","redirect_uri":"http://127.0.0.1:3071/auth/callback"}
```

本番の登録は別の client ID・HTTPS callback を使います。ローカル確認のために本番認証の登録や認証データを変更しないでください。

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

抽出器は PDF の表とページを解析し、企業の重複・ブース番号の欠落・指定企業の参照を検査します。会場マップの操作領域には、PDF 内の実際のブース矩形と OCR で読み取った番号を使います。画像に対する正規化座標を抽出し、番号と位置を一意に対応できない場合は推測せず停止します。原本・地図・座標入り JSON は非公開ファイルとして保存します。インポートは MySQL のトランザクションでデータと文書の許可リストをまとめて置き換えます。`DATA_DIR` は出力先を指定してください。

旧形式の取り込み済みデータにブース座標がない場合は、元 PDF を再抽出して再インポートします。番号や座標を画面コードへ直接記載しないでください。

## 画面と利用者設定

初回ログイン時に Ec4（電子制御工学科4年）の名簿番号を設定します。設定は Taskly アカウントごとに MySQL へ保存し、別端末でも引き継ぎます。登録できるのは取り込み済み資料に指定企業の割り当てがある番号です。「あとで」で省略でき、ヘッダーや見学リストから変更できます。認証アカウントから学籍を推定する処理はありません。

最初の画面は企業一覧です。検索・時間帯・業種・保存済みの絞り込みは専用の検索画面で行います。指定企業と気になる企業は一覧・見学リスト・マップで区別します。会場マップでは午前・午後を切り替え、ブースから企業詳細を開いたり、企業詳細から該当ブースを拡大表示したりできます。デスクトップはヘッダーのテキストナビゲーション、モバイルは下部のアイコン付きナビゲーションを使います。OS の外観設定に合わせてライト・ダークを切り替えます。

マップはマウス・タッチのドラッグで移動し、2本指のピンチ、Ctrl/Meta キーを押したホイール、拡大縮小ボタンで倍率を変えられます。マップにフォーカスした状態では矢印キーで移動、`+`・`-` で拡大縮小、`0` で標準倍率へ戻ります。「絞り込み」から企業名・業種・気になる企業・指定企業を選び、表示中の企業一覧からも企業詳細を開けます。

画面状態はルート URL のクエリで表します。`/` が企業一覧、`/?view=search` が検索、`/?view=schedule` がスケジュール、`/?view=map` がマップ、`/?view=plan` が見学リストです。`company` は企業詳細、`focus` はマップ上の注目企業、`session` は時間帯を指定します。`q`・`industry`・`saved=1` は検索条件、`assigned=1` はマップの指定企業絞り込みです。企業一覧へ戻っても検索条件は保持し、検索画面で再利用します。名簿番号は URL に含めません。再読み込み・戻る・進むや、ログイン後の画面復帰に対応します。

スケジュールの「配布資料の案内」は、元資料から抽出した見出し・段落・箇条書きで表示します。案内文そのものも実行時データとして扱い、画面コードへ埋め込みません。

地図と PDF は認証後に発行する署名付き URL で開きます。有効期間は最大5分で、発行元セッションの期限より長くなりません。取得時も発行元セッションと taskly-auth の失効状態を確認するため、発行元のセッションでログアウトした後は使用できません。URL 自体が一時的な閲覧権限を持つため、Git・公開コメント・ログへ保存しないでください。このページの名簿番号設定やブックマークは学校の提出・出席記録を代替しません。

## 検証とデプロイ

[テストとカバレッジ](docs/testing.md)、[本番運用と切り戻し](docs/deployment.md)を参照してください。CI はすべて GitHub ホストの `ubuntu-latest` ランナーで動作します。

既存 DB を更新する場合は、新しい API の配備前に `migrations/001_preferences.sql` を管理者権限で適用してください。新規 DB の `schema.sql` には同じ設定用テーブルが含まれています。

```sh
go test -race ./...
go vet ./...
npm --prefix apps/web run typecheck
npm --prefix apps/web run test:coverage
npm --prefix apps/web run build
node --test .github/scripts/coverage-summary.test.mjs deploy/*.test.mjs deploy/r2/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```
