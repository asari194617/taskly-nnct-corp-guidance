# 本番運用と切り戻し

## 構成

- R2 bucket `taskly-nnct-corp-guidance-2026-ui` は静的 UI 専用。公開開発用 `r2.dev` は使わない。
- UI の HTTPS は R2 custom domain が管理する証明書を使用。`/` だけ `/index.html` へ302転送する。
- API の DNS は `api.nnct-corp-guidance-2026.taskly.iy0306.com`、DNS-only。mirai-sv の Nginx が専用 Let's Encrypt 証明書で HTTPS を終端し、`127.0.0.1:3071` の Go コンテナへ転送する。
- API は既存 Docker network `infra_default` の MySQL 8.4 を使用する。専用 database `taskly_nnct_corp_guidance`、専用ユーザー `nnct_guidance` はこの DB の読み書きだけを許可する。
- 作業ディレクトリは `/home/ubuntu/taskly-nnct-corp-guidance`。外側のディレクトリ0700、`.env.production` は0600。`data` 内の文書は API UID10001 が読める0644で配置し、外側の非公開ディレクトリで保護する。

## 認証とデータの境界

本番の taskly-auth に public client を追加する際は、既存配列を保って次の登録を追加します。

```json
{"client_id":"nnct-corp-guidance-2026","redirect_uri":"https://api.nnct-corp-guidance-2026.taskly.iy0306.com/auth/callback"}
```

confidential client、既存利用者、認証の移行フラグは変更しません。API は PKCE と state をブラウザーに結び付け、callback の issuer を検証します。OAuth access token はサーバー側で暗号化し、ローカルセッションは15分で失効します。期限後は再ログインします。保護されたリクエストごとに taskly-auth の userinfo で失効を確認します。

企業一覧・指定企業・地図・原本の各 API は認証必須で `Cache-Control: no-store` を返します。Cookie は HttpOnly、Secure、本番は host-only。変更 API は正確な UI Origin を検証します。Nginx の新規 vhost は OAuth code/state をログへ残さないため access log を無効にします。

`SESSION_ENCRYPTION_KEY` は base64 の32バイト鍵です。暗号化鍵を変更すると既存セッションを読めなくなるため、鍵変更時は旧セッションの失効を伴う運用にします。

## GitHub Actions

[Deploy production](../.github/workflows/deploy.yml) は、main の最新コミットがその SHA で CI に合格済みであることを検証します。PR の成功だけでは本番へ配備しません。手動実行でも同じ main・CI 検査を行います。

| 環境 | 種別 | 名前 |
| --- | --- | --- |
| production-ui | secrets | R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY |
| production-ui | variable | R2_BUCKET |
| production-api | secret | PROD_SSH_KEY |
| production-api | variables | PROD_HOST、PROD_USER、PROD_SSH_PORT、PROD_SSH_KNOWN_HOSTS |

R2 資格情報は上記1バケットの Object Read & Write に限定します。API 配備鍵は新規サービス専用で、サーバー側の authorized_keys は `restrict,command=".../deploy-entrypoint.sh"` を設定します。private key を Actions に登録する際はユーザーの明示的な承認を得てください。

API イメージは GitHub のランナーでビルドし、コミット SHA と OCI revision label を付け、圧縮して SSH の標準入力で送ります。レジストリのパスワードを本番へ保存しません。強制コマンドは `deploy <40桁SHA>` だけを受け付け、排他制御、イメージの revision 検証、readiness 検査を実行します。

Compose と強制コマンドはサーバーに初回設置したファイルを使用します。これらの運用設定を変更する PR では、レビュー済みのファイルを管理者が明示的に同期してください。日常配備はイメージだけを送り、設定・鍵・データを上書きしません。

R2 配備は immutable asset を先、HTML を最後にアップロードし、旧 asset を保持します。HTML の Next.js bootstrap inline script から CSP の SHA-256 を生成し、meta CSP に埋め込みます。CSS の動的スタイルと認証済み blob 地図を許可し、スクリプトの `unsafe-inline` は使用しません。Cloudflare の応答ヘッダールールは新 UI host にだけ限定します。

## 初回起動・データ更新

初回はスキーマを専用 DB に適用し、私有 `data/guidance.json` と文書をサーバーへ置きます。最初の配備で importer が同一コンテナイメージから起動し、データをトランザクションで取り込みます。成功後 `.dataset-imported` を置き、以後のコード配備は既存データを保持します。

資料を更新するときは、元 PDF をリポジトリ外で再抽出し、`-check` で検証してから非公開ディレクトリをバックアップ・更新します。稼働中の SHA の importer を `--env-file .env.production --network infra_default -v "$PWD/data:/data:ro" --entrypoint /usr/local/bin/import-guidance` で実行し、`-input /data/guidance.json` を渡します。原本の検証と DB バックアップを行い、変更後はログインして件数・地図・指定企業を確認してください。

## ヘルス確認・切り戻し

`/healthz` は DB 接続、`/readyz` は DB 接続と取り込み済みデータの有無を確認します。これらには利用者情報や配布資料を含めません。未認証の `/api/guidance` と `/api/documents/...` が401になることも確認します。

新しい API が readiness に失敗した場合は `deployed-sha` に記録した旧 SHA へ戻します。初回で旧版がない場合は失敗したコンテナを停止します。DB と私有データは削除しません。UI だけ戻す場合は、正常だった main の成果物を同じ R2 bucket へ管理者が再配備します。通常の手動 Actions は最新 main の CI 合格を必要とするため、任意の旧 SHA を無検証で配備する入口はありません。

証明書は既存 `certbot.timer` で自動更新します。新 API 証明書専用の deploy hook が `nginx -t` に成功してから Nginx を graceful reload します。更新検査は新証明書の名前を指定した `certbot renew --cert-name ... --dry-run --run-deploy-hooks` で行います。
