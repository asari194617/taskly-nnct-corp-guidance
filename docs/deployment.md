# 本番運用と切り戻し

## 構成

- R2 bucket `taskly-nnct-corp-guidance-2026-ui` は静的 UI 専用。公開開発用 `r2.dev` は使わない。
- UI の HTTPS は R2 custom domain が管理する証明書を使用。Cloudflare の URL rewrite で `/` は `/index.html`、`/search/`・`/favorites/`・`/schedule/`・`/documents/`・`/map/` はそれぞれの `index.html` を取得し、外部URLとクエリを保持する。対象ページの末尾スラッシュなしURLは308で補完し、旧 `/index.html` はクエリ保持302で `/` へ転送する。旧 `?view=` は画面側で実ページへ正規化する。
- API の DNS は `api.nnct-corp-guidance-2026.taskly.iy0306.com`、DNS-only。mirai-sv の Nginx が専用 Let's Encrypt 証明書で HTTPS を終端し、`127.0.0.1:3071` の Go コンテナへ転送する。
- API は既存 Docker network `infra_default` の MySQL 8.4 を使用する。専用 database `taskly_nnct_corp_guidance`、専用ユーザー `nnct_guidance` はこの DB の読み書きだけを許可する。
- 作業ディレクトリは `/home/ubuntu/taskly-nnct-corp-guidance`。外側のディレクトリ0700、`.env.production` は0600。API は資料のファイルを読み込まず、非公開R2 bucketのオブジェクトへの一時URLだけを発行する。APIコンテナへPDF・PNGや私有 `data` ディレクトリをマウントしない。

## 認証とデータの境界

本番の taskly-auth に public client を追加する際は、既存配列を保って次の登録を追加します。

```json
{"client_id":"nnct-corp-guidance-2026","redirect_uri":"https://api.nnct-corp-guidance-2026.taskly.iy0306.com/auth/callback"}
```

confidential client、既存利用者、認証の移行フラグは変更しません。API は PKCE と state をブラウザーに結び付け、callback の issuer を検証します。ローカルセッションと Cookie はログインから30日間有効です。15分の OAuth access token とローテーションする refresh token をサーバー側でまとめて暗号化し、期限が近づくと taskly-auth の既存 refresh grant で更新します。更新してもローカルセッションの30日の期限は延長しません。保護されたリクエストごとに userinfo で失効と同一利用者であることを確認し、ログアウト時は refresh token のファミリー全体を失効させます。

更新は MySQL のセッション行ロックで直列化し、複数APIから同じ refresh token を使わないようにします。更新済みトークンは userinfo の再確認より先に永続化するため、一時的な userinfo 障害で古いトークンへ戻りません。更新の結果が不明になった場合はセッションを無効化して再ログインを要求し、使い終わった refresh token を再送しません。ブラウザーの切断時も、独立した有界の処理で更新結果の保存・失効を完了します。

既存の暗号化 access token のみのセッションは従来の短い期限で利用でき、次のログインから30日へ切り替わります。暗号化データは既存の BLOB 列へ保存するため追加DDLは不要です。この形式を知らない旧APIへ切り戻す場合、新形式のセッションは再ログインが必要ですが、名簿番号設定・気になる企業は保持されます。

企業一覧・指定企業・利用者設定と、文書 URL 発行の各 API は認証必須です。Cookie は HttpOnly、Secure、本番は host-only。変更 API は正確な UI Origin を検証します。名簿番号とブックマークは OAuth のユーザー ID ごとに保存し、名簿番号を URL へ含めません。

`GET /api/documents/{id}/url` は非公開R2のPDF・PNGに対するS3 presigned GET URLと `expires_at` を返します。AWS SDK for Go v2を使い、リージョン `auto`、path-styleで、MySQLの許可リストにあるフラットなファイル名だけを署名します。APIは資料本体を読み込んだり転送したりしません。有効期間は最大5分で、発行時のセッション残存期間も超えません。PDFの部分取得は同じGET URLに `Range` ヘッダーを付けてR2へ直接要求します。GETとHEADは署名のHTTPメソッドが異なるため、同じGET URLをHEADに使うことはできません。

R2のpresigned URLは一時的なBearer権限です。URL発行にはログインが必要ですが、発行済みURLはCookieなしで期限まで利用でき、**ログアウトで即時無効にはなりません**。ログアウト後の新しいURL発行は401です。すぐにすべての発行済みURLを止める緊急操作は署名用キーの失効や対象オブジェクトの退避であり、他の利用者にも影響します。通常は短い最大5分の期限を利用します。

従来の認証付き `/api/documents/{id}` はGET/HEADに応じたR2 URLへ302転送します。旧リリースが発行した `/documents/{id}?token=...` は旧HMAC・期限・セッション・認証を検証し、残存期間内のR2 URLへ転送します。新規のURL発行ではAPIホストのHMAC URLを生成しません。

APIの応答は `Cache-Control: no-store`、`Referrer-Policy: no-referrer` を返し、R2オブジェクトも `Cache-Control: no-store`、正しいMIME、inlineのContent-Dispositionを持たせます。presigned URLや資格情報を公開コメント、監視イベント、アクセスログへ記録しません。Nginxの専用vhostはOAuth code/stateや旧文書tokenを残さないためaccess log無効を維持します。R2を含む別のログ基盤を追加する場合も署名クエリを記録しない設定にします。

`.env.production` には `DOCUMENT_STORAGE=r2`、`R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` を設定します。エンドポイントは `https://<account-id>.r2.cloudflarestorage.com`。APIのキーは私有資料bucketだけのObject Readに限定し、UIの配備キーを流用しません。APIは設定が欠けたときに起動を拒否し、ローカルファイルへフォールバックしません。ローカル開発でも私有テストbucketかloopbackのS3互換サービスを使います。HTTPエンドポイントはAPI自体もHTTP loopback開発の場合だけ許可します。構成の詳細は [非公開R2](private-r2.md) を参照してください。

`SESSION_ENCRYPTION_KEY` は base64 の32バイト鍵です。暗号化鍵を変更すると既存セッションを読めなくなるため、鍵変更時は旧セッションの失効を伴う運用にします。

## GitHub Actions

[Deploy production](../.github/workflows/deploy.yml) は、main の最新コミットがその SHA で CI に合格済みであることを検証します。PR の成功だけでは本番へ配備しません。手動実行でも同じ main・CI 検査を行います。

API の配備・readiness・未認証アクセスの拒否を確認してから UI を配備します。新しい API ルートを使う画面が、旧 API より先に公開されることを防ぎます。

すべて GitHub ホストのランナーで実行します。配備後は企業情報・個人設定・保存情報・資料 URL 発行が未認証なら401、無効な署名 URL は403になることを検査し、画面の CSP・共有 URL・資料案内ページも確認します。成功したコミットと公開 URL は Actions の実行サマリーに記録します。

| 環境 | 種別 | 名前 |
| --- | --- | --- |
| production-ui | secrets | R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY |
| production-ui | variable | R2_BUCKET |
| production-api | secret | PROD_SSH_KEY |
| production-api | variables | PROD_HOST、PROD_USER、PROD_SSH_PORT、PROD_SSH_KNOWN_HOSTS |

UI配備用のR2資格情報はUI専用1バケットのObject Read & Writeに限定します。API 配備鍵は新規サービス専用で、サーバー側の authorized_keys は `restrict,command=".../deploy-entrypoint.sh"` を設定します。private key を Actions に登録する際はユーザーの明示的な承認を得てください。

API イメージは GitHub のランナーでビルドし、コミット SHA と OCI revision label を付け、圧縮して SSH の標準入力で送ります。レジストリのパスワードを本番へ保存しません。強制コマンドは `deploy <40桁SHA>` だけを受け付け、排他制御、イメージの revision 検証、readiness 検査を実行します。

Compose と強制コマンドはサーバーに初回設置したファイルを使用します。これらの運用設定を変更する PR では、レビュー済みのファイルを管理者が明示的に同期してください。日常配備はイメージだけを送り、設定・鍵・データを上書きしません。

R2 配備は immutable asset を先、HTML を最後にアップロードし、旧 asset を保持します。HTML の Next.js bootstrap inline script から CSP の SHA-256 を生成し、meta CSP に埋め込みます。CSS の動的スタイルと設定したR2 endpoint originの署名付き地図画像を許可し、スクリプトの `unsafe-inline` は使用しません。PDF は別タブで開き、iframe・object の埋め込みは許可しません。Cloudflare の応答ヘッダールールは新 UI host にだけ限定します。

Cloudflareのrewriteは画面コードのデプロイでは更新されません。UI hostのルートと上記5ページだけを対象に、それぞれの `index.html` へ内部書き換えし、`company`・`focus`・複数の `industry` などのクエリを保持します。末尾スラッシュの補完はその5ページだけに限定します。ルートから `/index.html` への旧302ルールは併存させません。配備後は各ページへの直接訪問・再読み込み・末尾スラッシュなし・`index.html` 別名・旧 `?view=` を確認し、各ページが固有のcanonicalを持つ静的HTMLを返すことも検査します。

## 初回起動・データ更新

資料の抽出・検証はリポジトリ外の管理用非公開ディレクトリで行います。原本・地図・PNGを私有資料bucketへ、元の `file_name` と同じルートキーでアップロードし、チェックサム・MIME・inline・no-store・未署名リクエストの拒否を確認します。JSONや原本をUI用bucketへ置きません。

スキーマ適用後、管理用環境から `cmd/import-guidance` を実行してMySQLへデータと文書の許可リストをトランザクションで取り込みます。インポーターの `-check` は元ファイルを持つ管理用ディレクトリで行い、R2のアップロード確認は別に実施します。APIの実行環境にPDF・PNGを配置する必要はありません。初回の管理用インポートが成功したことを確認してから、サーバー作業ディレクトリに `.dataset-imported` を作成します。配備スクリプトの互換性のため空の私有 `data` ディレクトリは残せますが、APIへマウントしません。既存配備の同マーカーは通常のコード配備で再取り込みしないために保持します。

ローカル資料からR2へ移行する既存環境は、先に資料をR2へアップロード・照合し、read-onlyキーを設定します。R2対応APIと、資料volumeを外したレビュー済みComposeを配備して動作を確認してから、旧 `data` 内のPDF・PNGを稼働領域から除去します。元資料は管理用の私有保存先とR2へ保持し、移行のために唯一のコピーを削除しません。旧ファイル配信APIへ切り戻す場合だけ、管理者が私有保存先から資料と旧volume設定を復元する必要があります。

既存 DB へ名簿番号設定を追加する場合は、新 API を配備する前に `migrations/001_preferences.sql` を管理者が適用します。新規 DB では `schema.sql` に同じテーブルが含まれています。この migration は既存データを保持する `CREATE TABLE IF NOT EXISTS` だけですが、通常どおり DB バックアップを確認してから実行します。アプリケーション用 DB ユーザーに DDL 権限を追加したり、日常のイメージ配備で自動実行したりはしません。

レビュー済みの migration を本番作業ディレクトリへ同期した後、既存 MySQL コンテナへ標準入力で渡す例は次のとおりです。パスワードを引数や出力へ表示しません。

```sh
docker exec -i infra-db-1 sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot taskly_nnct_corp_guidance' \
  < migrations/001_preferences.sql
```

適用後に `guidance_preferences` テーブルが存在することを確認します。`/readyz` の成功だけでは追加テーブルの適用確認を代替できません。ロールバックで旧 API へ戻す場合も、この追加テーブルと保存済み番号を削除する必要はありません。

資料更新時も管理用の非公開ディレクトリで再抽出・`-check`・元資料の照合を行い、MySQLとR2オブジェクトのバックアップを確認します。検証した資料をR2へ反映し、同じ結果のJSONを管理用importerでMySQLへ取り込みます。APIコンテナへ私有資料のvolumeを戻して作業しないでください。既存キーを置換する場合、まだ有効な短いURLが新しいオブジェクトを指すため、更新のタイミングも確認します。変更後はログインして地図・指定企業・R2からのPDF表示を確認してください。

ブースを選択できるマップへの更新には、Tesseract OCR と `scripts/requirements-data.txt` の Python 依存関係を持つ環境で元 PDF を再抽出します。ブース矩形は PDF の描画要素から、番号は OCR から取得します。描画後の画像に対する正規化座標と画像寸法も私有 JSON に含まれるため、同じ抽出結果の JSON と画像を組で更新してください。位置を推測して画面へ埋め込まないでください。OCR が一意に対応できない場合は抽出が停止するため、元資料と抽出環境を確認します。案内文の見出し・段落・箇条書きを持つ `notice_sections` も再抽出時に生成します。

## ヘルス確認・切り戻し

`/healthz` は DB 接続、`/readyz` は DB 接続と取り込み済みデータの有無を確認します。これらには利用者情報や配布資料を含めません。未認証の `/api/guidance` と `/api/documents/...` が401になることも確認します。

ログイン後は Ec4 の名簿番号設定・変更、別端末での設定保持、指定企業の表示、マップの時間帯切り替え・ブース選択・企業詳細との往復を確認します。R2のpresigned PDFが別タブで開き、URLの改変・未署名アクセス・期限切れを拒否すること、発行元のログアウト後に新規URL発行が401になることも確認してください。発行済みR2 URLは短い期限までは利用可能です。実際の番号、文書 URL、画面の実データを公開チェック結果へ貼り付けないでください。

新しい API が readiness に失敗した場合は `deployed-sha` に記録した旧 SHA へ戻します。初回で旧版がない場合は失敗したコンテナを停止します。DB と私有データは削除しません。UI だけ戻す場合は、正常だった main の成果物を同じ R2 bucket へ管理者が再配備します。通常の手動 Actions は最新 main の CI 合格を必要とするため、任意の旧 SHA を無検証で配備する入口はありません。

証明書は既存 `certbot.timer` で自動更新します。新 API 証明書専用の deploy hook が `nginx -t` に成功してから Nginx を graceful reload します。更新検査は新証明書の名前を指定した `certbot renew --cert-name ... --dry-run --run-deploy-hooks` で行います。
