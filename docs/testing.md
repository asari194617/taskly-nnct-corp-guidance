# テストとカバレッジ

オフライン対応では実Service Worker・IndexedDBを使うブラウザー検証も実行します。Service Workerの実行カバレッジはページE2Eと分けてNodeで計測し、行・分岐・関数80%以上を要求します。PRレポートとLCOV artifact、再現手順は [オフライン参照](offline.md) に記載しています。

CI は PR と main の全変更で動作します。パスによる省略やセルフホストランナーへの切り替えはありません。`required-ci` は API、Web、データ抽出、ブラウザー E2E、MCP HTTP E2E、Linux 本番イメージ、品質チェックの7ジョブがすべて成功した場合だけ成功します。

## 計測する範囲

| レポート                | 計測                                                    | 合格基準                             |
| ----------------------- | ------------------------------------------------------- | ------------------------------------ |
| Go アプリケーション全体 | `go test -race -coverprofile`、API と各コマンド         | statements 80%以上                   |
| インポーター            | 同じ Go プロファイルの対象コマンド                      | statements 80%以上                   |
| Web                     | Vitest + V8、アプリケーションコード                     | lines 80%以上                        |
| Service Worker          | 配備する関数そのものをNodeで実行                        | lines・branches・functions 各80%以上 |
| PDF 抽出器              | coverage.py、テストコードを除く scripts                 | statements 80%以上                   |
| 実 MySQL 結合テスト     | `^TestMySQL` だけを実行し、`internal/server` 全体を計測 | statements 80%以上                   |
| ブラウザー E2E          | Chromium の画面操作で実行されたソースの範囲を V8 で計測 | 実測値を報告                         |

MCP の API スイート・実 MySQL コンポーネントも、それぞれ既存の全体プロファイルから `internal/server/mcp` で始まる全ファイルをリテラルの prefix として集計し、statements 80%以上を必須にします。API スイートは MySQL を利用できる CI では結合テストも含むため、単体だけの値とは表示しません。元の API 全体・実 MySQL 全体の分母と80%の基準は変更しません。PR では2つの MCP 達成率と、MCP HTTP E2E の18項目の件数を別々に表示します。 prefix 集計には covered/total の statements も表示します。今回の最終ローカルプロファイルでは、MCP は単体を含む全 Go テストで339/355（95.49%）、独立した実 MySQL テストで308/355（86.76%）です。未絞り込みの全 Go は1412/1518（93.02%）、実 MySQL は1157/1350（85.70%）で、これらの分母から MCP を除外していません。CI はその実行時の値を改めて計測します。

単体テストの合算値と結合・E2E 単独の実行範囲は別の指標です。後者の値を単体カバレッジと合算したり、操作が通っただけで100%と見なしたりしません。行カバレッジだけで全分岐の正しさは保証されないため、未認証・状態不一致・他ユーザー・不正パス・失効・障害時のケースもテストします。

Go の実 MySQL 結合テストとブラウザー E2E は CI 専用の MySQL 9.7.4 LTS と架空ユーザーを使い、OAuth PKCE、認証が必要な資料・企業情報、ユーザー別ブックマークと名簿番号設定、別端末からの共有、署名付き文書 URL、ログアウトと失効を確認します。本番の認証サービスや実際の配布資料は使いません。

## 会場マップ・利用者設定の確認

- Goの文書テストはS3 presigned URLの有効期間、対象オブジェクト・HTTPメソッド・レスポンス属性との署名の結び付け、未署名・改変・期限切れの拒否、発行時の認証とセッションの上限を確認します。独立したSigV4検証器でSDKの出力を照合し、Range付きGETにも対応します。発行済みR2 URLはログアウト直後も短い期限まで有効で、新規発行は拒否されることを区別します。
- 名簿番号設定は未認証・Origin 不一致・不正な値・資料に割り当てがない値を拒否し、利用者間で値が混ざらず別端末で保持されることを確認します。初期対象は Ec4 で、番号を URL へ保存しません。
- Web のテストは初回番号設定・変更・省略、指定企業表示、ホームのやること・おすすめと専用検索画面、検索条件と保存、URL の直接訪問・再読み込み・戻る・進む、デスクトップのヘッダーとモバイルのナビゲーションを対象にします。OS の外観に合わせたライト・ダークと、案内文の見出し・段落・箇条書きも確認します。
- マップのテストは架空の矩形データでブース選択・午前午後の対応・指定企業と保存企業の表示・企業詳細からの注目位置・資料リンクを確認します。ドラッグ移動、ピンチ・ホイール・キーボードによる拡大縮小、絞り込み後の表示件数と企業一覧、操作後に意図しない企業詳細が開かないことも対象です。座標が不正な領域は操作対象にせず、別フロアにブースを推測して追加しません。
- Python のテストは PDF の矩形変換、OCR 候補の一意な対応、欠落・競合・曖昧な認識の拒否、案内文の構造化を架空データで確認します。単体テストは OCR 呼び出しを模擬し、本物の配布資料を CI へ持ち込みません。元資料を取り込む際の視覚確認は、公開テスト成果物とは分けて行います。

ブラウザー E2E は実際の Go API と MySQL、検証用 OAuth サーバーを通して上記の利用フローを確認します。PDFは `blob:` やAPIのファイル転送ではなく、R2互換S3サービスへのpresigned URLで開きます。実Go/MySQLと、独立したSigV4検証・期限検査・Range/HEADを実装したloopbackオブジェクトサービスを使い、内容・ヘッダー・改変拒否・期限・ログアウト後の新規発行拒否を検証します。テスト用サービスが本番のR2へ接続することはありません。企業詳細とマップのクエリは再読み込みと履歴操作でも確認し、名簿番号が URL へ入らないことも検査します。

ホームの完了チェックは、実際の Taskly Go サーバーの連携エンドポイント、GraphQL、MySQL の完了記録まで通します。CI はレビュー済みの Taskly コミットを固定して取得し、検証専用コマンド `apps/server/cmd/guidance-e2e` を起動します。OAuth の userinfo と introspection は同じ架空の数値ユーザー ID を返し、Taskly の通常の完了・取り消し操作とガイダンス側のチェックが同じ記録を参照することを確認します。フォームを開くだけではチェックが変わらず、見学シート用 PDF は実際に25ページ目が存在する26ページの架空資料を使います。

見学アンケートと同じタームの指定企業は、実際の Taskly トランザクションで同時に完了します。ガイダンス経由で自動完了した組だけは、ガイダンス画面のどちらのチェックから解除しても両方を解除できることを確認します。以前の手動完了や、Taskly 標準 GraphQL で後から明示的に操作した項目は保護し、別ターム・指定のないターム・別アカウント・変更後の名簿設定へ連動が漏れないことも確認します。自動完了の由来はサーバーに保存し、再読み込み後も照合します。

この連動の E2E は応答を作り替えず、本物の PUT の転送を一時的に保留して楽観的表示と操作中の状態を確認し、解放後に返る関連タスクと Taskly 標準 GraphQL の完了記録を照合します。完了不可の相手を含む409、認証基盤の503、トークン失効の401では部分的な完了が残らず、逆方向の解除が失敗した場合も両方が元の状態へ戻ることを確認します。MySQL のトランザクションそのものの結合テストとブラウザーの行カバレッジは別々に報告します。

Taskly 検証サーバーは loopback、検証フラグ、空の `taskly_guidance_e2e` DB を必須とし、本番モードでは起動しません。E2E ランナーはこの固定名の使い捨て DB を毎回作り直します。Taskly の本番 DB、セッション、認証情報は使用しません。Redis は検証プロセス内で起動し、別の常駐サービスは不要です。

PDF の署名 URL を取得した後は現在のタブで資料へ移動します。Chromium の既存 E2E に加え、iPhone 設定の WebKit 専用プロジェクトで配布資料と見学シートを確認します。`window.open` を禁止しても実際の署名 URL へ移動でき、署名の取得が401・503の場合はアプリの画面に留まることを、実 Go API と検証用認証サーバーで確認します。ネイティブの PDF ビューアーが開くエンジンでは「戻る」、ダウンロード扱いになるヘッドレスエンジンではアプリに留まることを検証し、再読み込み後の認証も確認します。これは WebKit エンジンの検証で、実機の Google アプリや Safari 自体の動作確認とは区別します。

WebKit の実行結果は同じ Playwright レポートに別プロジェクトとして記録します。WebKit は V8 のカバレッジ API を持たないため、行カバレッジは Chromium の測定値だけを表示し、WebKit の成功件数をカバレッジへ換算・合算しません。CI は全変更で両エンジンをインストールし、両プロジェクトを実行します。

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
npm --prefix deploy/r2 ci --ignore-scripts
node --test .github/scripts/coverage-summary.test.mjs deploy/*.test.mjs deploy/r2/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```

実 MySQL テストは使い捨ての専用 DB を用意し、`MYSQL_TEST_DSN` を渡して `go test -race -run '^TestMySQL' -coverprofile=/tmp/guidance-integration.out ./internal/server` を実行します。テストはスキーマを準備し、架空データを書き込みます。稼働データを含む DB の DSN を使わないでください。

ブラウザー E2E は `E2E_MYSQL_PASSWORD` と `E2E_MYSQL_DATABASE` に別の使い捨て DB の接続先を指定し、`E2E_TASKLY_DIR` にレビュー済み Taskly チェックアウトのルートを指定します。MySQL アカウントには固定名 `taskly_guidance_e2e` の作成・削除権限も必要です。`npm --prefix apps/web exec -- playwright install --with-deps chromium webkit` で両ブラウザーをインストールしてから `node scripts/e2e-run.mjs` を実行すると、スクリプトが架空データの取り込み、ローカル OAuth サーバー、両サービスの Go API、Next.js 静的本番ビルドの配信を準備します。詳細な出力先はスクリプトと `apps/web/e2e` を参照してください。

実 MySQL 結合テストは `TestMySQL` で始まるテストだけを選び、`internal/server` 全体の実行カバレッジを単独で測定し、80%以上を必須にします。API 全体のテストやブラウザー E2E の値を合算せず、ファイル・処理の除外も行いません。同一リポジトリと fork の PR コメントの両方で、結合テストの達成率と80%の基準を表示し、元のプロファイルを artifact に保存します。

テストは実際の `SQLStore` と HTTP API を使い、PKCE ログイン、暗号化セッション・更新・失効、名簿設定の永続化と利用者分離、ホームのチェック連動・両方向解除・手動チェック保持、SQL 障害時の取り消し、資料リンク、読み込み回数制限を検証します。この独立した結合テストでは OAuth と Taskly はローカル HTTP 境界で模擬します。実際の Taskly Go API・正規の完了テーブルまで接続する検証は、別のブラウザー E2E と Taskly 側の実 MySQL テストで行い、そのカバレッジとは区別します。

## MCP の実3サービス E2E

`mcp-e2e` ジョブは全 PR・main の全変更で実行し、パスや変更内容による省略はしません。レビュー済みの固定コミットから Auth と Taskly を取得し、実際の Auth・Taskly・Guidance の Go HTTP サーバーを起動します。MySQL 8.4 はこのジョブ専用で、通常のブラウザー E2E の MySQL と共有しません。

Auth は非公開リポジトリのため、そのリポジトリだけを読み取れる専用 Deploy key を Guidance の Actions Secret `MCP_AUTH_REPO_SSH_KEY` に保存し、Auth の checkout にだけ渡します。固定コミットと `persist-credentials: false` を維持し、広い権限の PAT や本番用の鍵は使いません。通常の Actions Secrets が渡らない fork・Dependabot の PR では checkout が失敗し、必須ジョブも失敗します。秘密情報がない場合のスキップ、別の token へのフォールバック、`pull_request_target` への切り替えは行いません。Auth のソースを公開リポジトリへコピーしたり、artifact として配布したりしません。

公式 Go MCP SDK 1.8.0 のクライアントから、初期化・全8ツールの列挙、本人確認、企業検索・詳細、本人の指定企業、固定の資料ページリンク、「気になる」の保存、Taskly 正規テーブルに対する完了連動と両方向の解除まで18項目を検証します。Auth は架空アカウントの通常のパスワード認証、PKCE とリソースの結び付け、一度だけ使える明示的同意、更新、短期委譲を実際に処理します。認証・Taskly・Guidance の業務応答はモックしません。読み取り専用スコープ、Taskly の閲覧権限不足、別リソースのトークン、親トークン失効、更新トークンの再利用も拒否することを確認します。Guidance のブラウザーセッションを代用しないことも SQL で検査します。

検証用クライアントは `tests/mcp-e2e-client` の独立した Go モジュールです。アプリ本体の `go test ./...` の計測対象へテスト用実行コマンドを混ぜず、実際の MCP API コードは通常の Go 単体・実 MySQL カバレッジに含めます。この18項目は機能テストの成功件数であり、ブラウザーの V8 カバレッジや API の statements と合算・換算しません。実際の ChatGPT 画面や外部 OAuth コールバック先を操作するテストとも区別します。

ローカルでは空の使い捨て MySQL と、レビュー済みの2リポジトリを用意して実行します。ランナーはリテラルの `127.0.0.1` と固定の検証 DB 名だけを許可し、本番モード・アプリ用 DSN・中身のある DB・使用中のサービス用ポートを拒否します。DB は自動削除せず、失敗時にも実行したサービスの PID だけを停止します。DB 名は `taskly_auth_mcp_test`、`guidance_mcp_e2e`、Taskly 既存ハーネス指定の `taskly_guidance_e2e` です。

```sh
MCP_E2E_AUTH_DIR=/path/to/reviewed-taskly-auth \
MCP_E2E_TASKLY_DIR=/path/to/reviewed-taskly \
MCP_E2E_MYSQL_PASSWORD=synthetic-ci-only \
MCP_E2E_GO=/path/to/go1.27.4/bin/go \
MCP_E2E_TASKLY_GO=/path/to/go1.26.10/bin/go \
node scripts/mcp-e2e.mjs
```

必要なら `MCP_E2E_MYSQL_PORT` で使い捨て MySQL のポートを指定できます。Node は `.nvmrc` の版、Auth・Guidance・クライアントは Go 1.27.4、Taskly は Go 1.26.10 を使います。`coverage/mcp-e2e/` に18項目の JSON、合成データだけのログ、前後のソースハッシュ、停止確認を保存し、CI の `mcp-http-e2e` artifact として取得できます。OAuth トークンや実データは出力しません。
