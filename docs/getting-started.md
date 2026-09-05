# クイックスタート

vrev は、HTML・画像・Web アプリに直接注釈を付けて、AI による修正や GitHub Issue につなげるローカルレビューツールです。

このページでは、起動済みのローカルアプリをレビューするまでの手順を紹介します。

## 1. 必要な環境を用意する

| 環境 | 用途 |
| --- | --- |
| **Node.js 20 以上** と npm | vrev のインストール・起動 |
| 対応する coding agent CLI | AI 修正を使う場合のみ |
| 認証済みの GitHub CLI (`gh`) | GitHub Issue を作成する場合のみ |

::: tip まずは注釈だけでも
AI や GitHub の設定は後から追加できます。まずは対象を開いて、注釈を付けてみましょう。
:::

## 2. インストールする

レビュー対象のプロジェクトで、Core と標準の機能パッケージをインストールします。

```bash
npm install --save-dev \
  @vrev/cli@1.0.0-beta \
  @vrev/ai@1.0.0-beta \
  @vrev/review@1.0.0-beta \
  @vrev/annotation-workflow@1.0.0-beta \
  @vrev/page-map@1.0.0-beta \
  @vrev/github-issue@1.0.0-beta
```

Firestore によるリモートストレージが必要な場合は、`@vrev/storage-firestore@1.0.0-beta` も追加してください。Core はプロジェクトの `package.json` にある直接依存からプラグインを検出します。

## 3. 対象を開く

アプリの開発サーバーを起動し、その URL を指定します。

```bash
npx @vrev/cli serve --target http://127.0.0.1:5173
```

`5173` は例です。実際の開発サーバーのポートに置き換えてください。

vrev は既定でポート `18765` を使用し、ブラウザを自動で開きます。使用中の場合は次の空きポートを選びます。自動で開かない場合は、ターミナルに表示された URL を開いてください。

### HTML や画像を開く

```bash
# 静的 HTML
npx @vrev/cli serve --target ./index.html

# 画像
npx @vrev/cli serve --target ./assets/example.png

# HTTPS ステージング
npx @vrev/cli serve --target https://staging.example.com/products
```

パスや URL は実際のレビュー対象へ置き換えてください。

### 開発サーバーも一緒に起動する

```bash
npx @vrev/cli serve \
  --target http://127.0.0.1:5173 \
  --start "npm run dev"
```

ブラウザの自動起動が不要な場合は `--no-open` を追加します。

::: warning 公開 HTTPS サイトの JavaScript
公開 HTTPS URL では、対象の JavaScript は常に無効です。ローカル対象では既定で有効で、左上の「設定」から無効化できます。
:::

## 4. 最初の注釈を付ける

1. `N` で DOM ノード、または `R` で矩形範囲を選びます。画像では矩形範囲を使います。
2. 対象の場所を選び、変更してほしい内容を入力します。
3. `⌘+Enter` / `Ctrl+Enter` で送信します。
4. `V` で閲覧モードに戻ります。

次は [レビューワークフロー](./workflow) で、AI 修正や Issue 作成までの流れを確認しましょう。
