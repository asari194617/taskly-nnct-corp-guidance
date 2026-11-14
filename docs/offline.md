# 会場でのオフライン参照

通信できる間に一度開くと、企業一覧・絞り込み・指定企業・スケジュール・気になる・ホームの最終取得状態と、取得できた会場マップを同じ端末で参照できます。保存期限は24時間です。ブラウザーによるストレージ削除・容量不足・プライベートブラウズなどでは保存できない場合があります。一度もオンラインで開いていない端末は画面自体を取得できません。画面を取得済みでも個人用データがない場合は未取得と表示します。

オフライン中の完了切替、気になるの変更、名簿変更などの書き込みは行いません。処理をキューに積んだり未同期の変更を完了表示にしたりせず、通信復帰後にサーバーの状態を取り直します。PDFの閲覧と外部アンケートの回答には通信が必要です。

## 保存境界

- **公開の静的画面**: Service Worker `/offline-worker.js` が、ビルド時に列挙した6ページのHTML・`_next/static/` のJS/CSS/フォント/画像・TasklyロゴだけをCache Storageに保存します。`taskly-guidance-shell-v1-<revision>` にSHA-256で検証した全ファイルと取得時刻を保存します。クエリ付きのページ訪問は既知の画面パスへ対応させ、クエリ・企業名・検索語をCache Storageのキーに保存しません。API、認証、PDF、署名付きURL、他origin、任意パス、書き込み、Rangeリクエストには介入しません。
- **個人用スナップショット**: `lib/offline-store.ts` が、オンラインで確認したアカウントと学科・学年・名簿番号の組み合わせに限定してIndexedDBへ保存します。型に沿って必要な値だけを再構築し、セッショントークン・OAuth情報・署名付きURLは保存しません。別アカウント、ログアウト、401、名簿変更時は破棄し、古い通信結果が保存を復活させない世代番号で制御します。
- **会場マップ**: 取得した画像バイトだけを同じアカウント・名簿・データ版・期限の範囲で保存します。署名URLの期限切れ後も取得済みの画像を参照でき、表示用の一時的なBlob URLは解放します。PDFのBlob表示は導入しません。

公開シェルも個人用スナップショットも24時間を超えるとオフライン参照に使いません。公開シェルはオンラインの画面アクセス時に取得から1時間以上経過していれば全ファイルを再確認し、全て同じビルドであることを検証できた場合に限り取得時刻を更新します。個人用データは正常に確認できた内容だけを保存します。

## 取得・更新・配備

`npm --prefix apps/web run build` は静的出力後に `deploy/r2/offline-shell.mjs` で公開資産のマニフェストとService Workerを生成します。R2への配備時はCSPを入れた最終HTMLから再生成し、JS/CSS等 → HTML → Service Workerの順でアップロードします。`offline-worker.js` は `text/javascript; charset=utf-8` と `Cache-Control: no-cache`、ハッシュ付き `_next/static/` は1年間immutableです。登録時も `updateViaCache: none` を指定します。既存のR2 custom domainとURL rewriteを利用するため、新しいWorkerサービスや公開データ用バケットは不要です。

インストール時はファイルのHTTP成功とSHA-256が全て一致してから使用可能にします。配備途中の異なる版が混じったときはインストールを失敗させます。新しいService Workerは既存の画面を強制切替せず、その画面が閉じられてから有効になります。有効化後に自分の旧シェルキャッシュだけを削除し、他のキャッシュには触れません。配備済みの旧ハッシュ付き資産もR2から削除しません。通常のHTMLアクセスを優先し、通信断や5xxでは期限内の保存済み画面に戻ります。画面応答が4秒間ない場合も保存済み画面へ戻ります。資産取得は15秒で中断し、初回準備の完了待ちは20秒で打ち切ります。

CSPは既存のスクリプトSHAと `frame-src 'none'` / `object-src 'none'` を維持し、`worker-src 'self'`、同一originと指定R2 originへの `connect-src`、画像に限定した `img-src blob:` を追加します。R2の許可は配備アカウントから組み立てた正確なS3 originに限定します。PDF・APIに対する汎用的なService Workerキャッシュや新たなCDN Cache Everythingルールは追加しません。

## 検証とカバレッジ

既存の必須CIジョブは全ての変更で実行されます。Web unit coverageには保存・認証境界・オフラインUIを含め、Service Workerは実際に配備する関数そのものをNodeで別途実行し、行・分岐・関数それぞれ80%以上を要求します。PRには `Service worker unit execution` の行カバレッジを表示し、LCOVをCI artifactに保存します。この数値はページJavaScriptのChromium E2Eカバレッジとは別です。ブラウザー結合テストでは実際のService WorkerとIndexedDBを使い、通信断からの再読み込み・直接ページ訪問・画像表示・書き込み抑止・期限切れ・認証変更・オンライン復帰を検証します。

単独でシェルのテストとカバレッジを再現するには、Node 26.13.1で次を実行します。

```sh
mkdir -p coverage
node --experimental-test-coverage --test-coverage-include=deploy/r2/offline-worker.mjs \
  --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage/offline-worker.lcov \
  --test deploy/r2/offline-worker.test.mjs
node .github/scripts/coverage-summary.mjs lcov coverage/offline-worker.lcov offline-worker.json 80 'offline-worker\.mjs$'
node --test deploy/r2/offline-shell.test.mjs deploy/r2/plan.test.mjs
```
