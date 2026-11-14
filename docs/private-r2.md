# 配布資料の非公開R2ストレージ

配布PDFと地図画像は、UI用バケットとは別の非公開R2バケットへ格納します。企業情報・学生別割り当て・抽出JSON・DBダンプはアップロードしません。アップロード対象は私有 `guidance.json` の `documents` に登録された文書だけです。

## バケットと権限

- バケット名: `taskly-nnct-corp-guidance-2026-documents`
- ストレージクラス: Standard。r2.dev公開アクセスは無効、カスタムドメインなし。
- オブジェクトキー: `documents[].file_name` と同じ、ディレクトリを含まないファイル名。
- API実行用の資格情報: このバケットだけに限定した Object Read only。UI配備用のキーは変更・流用しない。
- 更新作業: 対象バケットへ書ける管理者の資格情報を使う。API実行用キーへ書き込み権限を追加しない。

[Cloudflareの認証ガイド](https://developers.cloudflare.com/r2/api/tokens/)に従い、バケットを指定してキーを作成します。OAuthによるR2管理権限と、S3互換APIのAccess Key ID / Secret Access Keyは別です。APIトークン管理権限のないOAuth認証から、S3キーを新規作成することはできません。

## サーバーの設定

本番サービス専用の `.env.production` に次の名前を設定します。値をGit・Actionsログ・公開コメントへ含めません。

```dotenv
DOCUMENT_STORAGE=r2
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_BUCKET=taskly-nnct-corp-guidance-2026-documents
R2_ACCESS_KEY_ID=<bucket-scoped-read-only-access-key-id>
R2_SECRET_ACCESS_KEY=<bucket-scoped-read-only-secret>
```

既存のComposeは `env_file` からこれらを読み込みます。データベース・認証・暗号化鍵など、他の設定を置き換えないでください。資格情報はビルドへ渡さず、APIコンテナの実行時だけに渡します。

## 資料のアップロードと検証

元PDFの抽出と検証は、引き続きGit外の非公開ディレクトリで行います。各文書をアップロードするときは、次のメタデータを設定します。

| 項目                | 設定                                                            |
| ------------------- | --------------------------------------------------------------- |
| Content-Type        | 文書の `mime_type`。PDFは `application/pdf`、地図は `image/png` |
| Content-Disposition | `inline; filename="<file_name>"`                                |
| Cache-Control       | `no-store`                                                      |

[R2のオブジェクトAPI](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/)またはS3互換APIを利用できます。Cloudflare CLIは `cf r2 buckets objects` で管理できます。CLIに必要なHTTPメタデータの指定がない場合は、REST APIのアップロードリクエストへ上記ヘッダーを付けます。

アップロード後は、管理者権限で全オブジェクトを読み戻し、元ファイルとのSHA-256一致・MIME・inline指定・no-storeを確認します。バケット一覧が文書の許可リストと一致し、抽出JSONや学生データが含まれていないことも確認します。

## CORS

ブラウザーから署名付きURLを使うため、対象画面のoriginだけへ読み取りを許可します。CORSでバケットを公開状態に変更することはありません。

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://nnct-corp-guidance-2026.taskly.iy0306.com"],
        "methods": ["GET", "HEAD"],
        "headers": ["Range", "Content-Type"]
      },
      "exposeHeaders": [
        "ETag",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "Content-Disposition"
      ],
      "maxAgeSeconds": 600
    }
  ]
}
```

[CloudflareのCORSガイド](https://developers.cloudflare.com/r2/buckets/cors/)に従い、応答の検証では実際のUI originを `Origin` ヘッダーに指定します。

## 署名付きURLの境界

認証済みAPIが最長5分かつ元セッションの残り期限以内のpresigned GET URLを発行し、ブラウザーはR2から直接読み込みます。資料本体をアプリケーションサーバーへ中継しません。

発行済みURLを持つ利用者は、そのURLの期限まで資料を取得できます。ログアウトで新規発行を止めても、既に発行したR2 URLを個別に即時失効することはできません。URLは一時的な閲覧権限として扱い、ログ・分析イベント・共有コメントへ残さないでください。期限切れ後は認証済みAPIから再発行します。詳細は[Cloudflareのpresigned URLガイド](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)を参照してください。

R2移行前のローカル文書は、新APIとR2からの読み取りを確認するまで保持します。移行後にアクティブなデータディレクトリから外す場合も、取り込み手順と切り戻し方法を確認してから行います。

APIを先に更新する移行では、旧UIのCSPでもR2画像を表示できるよう、事前にHTMLの `img-src` へそのアカウントの正確なR2 S3 originだけを追加します。稼働中HTMLの原本を非公開領域へ保存し、追加するorigin以外のHTMLバイト列・スクリプトのSHAハッシュ・Content-Type・no-cacheを保持します。準備後に別の配備でHTMLが変わっていた場合は上書きせず、準備をやり直します。これは移行時だけの互換対応です。以後のUI配備では通常のCSP生成処理が同じoriginを含みます。

最初のR2対応APIは、切り戻しに備えて従来のホスト側Composeで配備します。R2対応版の正常稼働と画面からの直接取得を確認した後、レビュー済みの新しい `compose.production.yaml` をホストへ同期し、同じ配備SHAでAPIを再作成して資料ディレクトリのマウントを外します。以後のAPI実行時にローカルPDF・PNGは不要です。R2への転送・読み戻し検証が済んだ文書だけを、許可リストに従ってホストのアクティブなデータディレクトリから削除します。JSONの取り込み元やDBは削除しません。

R2対応前のAPIへ切り戻す場合は、旧Composeのマウントを復元し、同じ私有バケットから文書を非公開ディレクトリへダウンロードしてから起動します。取り込み・更新は管理者のGit外の作業場所で元資料と抽出結果を検証して行い、API実行コンテナへ文書を置く運用へ戻さないでください。
