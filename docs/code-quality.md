# Lint・format

Node.jsは`.nvmrc`、Goは`go.mod`の版を使用します。BiomeとRuffは依存ファイルで版を固定しています。

```sh
npm --prefix apps/web ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-lint.txt

# リポジトリ全体のlintと、変更しない整形チェック
npm --prefix apps/web run lint
npm --prefix apps/web run format:check

# 整形を適用し、lintとテストで確認
npm --prefix apps/web run format
npm --prefix apps/web run lint
```

`apps/web`内でも同じ`npm run`コマンドを使用できます。実行スクリプトが常にリポジトリのルートを基準に処理します。

| 対象                                   | lint                              | format  |
| -------------------------------------- | --------------------------------- | ------- |
| JavaScript・TypeScript・JSX・JSON・CSS | Biomeの推奨ルール                 | Biome   |
| YAML・Markdown                         | Biomeが提供する構文・推奨ルール   | Biome   |
| Python                                 | Ruffの標準ルール（E4・E7・E9・F） | Ruff    |
| Go                                     | `go vet ./...`                    | `gofmt` |

Biomeの対象拡張子と除外は`biome.json`に定義しています。Gitのignoreも尊重し、資料・抽出データ・環境変数・PDF・SVG・画像・生成物・依存ディレクトリを整形しません。生成されたlockファイルと`next-env.d.ts`も対象外です。PythonもGitのignoreと`ruff.toml`の除外に従います。GoはGit管理下とignore対象外の`.go`ソースを処理します。差分のあるファイルだけに絞り込まず、対象ソース全体を検査します。

シェル・Dockerfile・nginx設定・TOML・依存一覧テキストには、このコマンドから専用formatterを適用しません。各設定の読み込みやビルド・配備テストは既存CIで検証します。

CIの`quality`ジョブは変更ファイルの種類を問わず実行し、lintとformatチェックの成功を`required-ci`で必須にします。自動整形の適用や自動コミットは行いません。
