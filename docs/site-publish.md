# ドキュメントサイト公開手順（VitePress + GitHub Pages）

このリポジトリの `docs/*.md` を [VitePress](https://vitepress.dev/) でビルドし、GitHub Pages で公開する手順です。
使う document ライブラリは VitePress（Node 20+、本リポジトリの CI と同条件）です。

公開 URL: `https://NAKAK10.github.io/vrev/`

## 構成

```text
docs/
├── .vitepress/config.mts   # サイト設定（title / base / nav / sidebar）
├── index.md                # トップページ（hero + features）
├── site-publish.md         # このページ
├── plugin-guide.md         # プラグイン開発ガイド
├── plugins.md              # プラグイン基盤 contract
└── public/images/          # スクショ置き場
```

`base: '/vrev/'` が public リポジトリの Pages 配下パスに対応します。カスタムドメインを使わない限り変更不要です。

## ローカル確認

```bash
npm ci
npm run docs:dev      # http://localhost:5173/vrev/ でプレビュー
npm run docs:build    # docs/.vitepress/dist へ静的出力
npm run docs:preview  # ビルド結果の確認
```

## GitHub からの公開

`.github/workflows/docs.yml` が `main` への push（`docs/**` 変更時）と手動 dispatch で動作します。

```text
build（npm ci → docs:build → upload-pages-artifact）
  → deploy（actions/deploy-pages@v4 → github-pages environment）
```

初回のみ GitHub 側で 1 回だけ操作が必要です（コードでは設定できません）:

1. `Settings > Pages > Build and deployment > Source` を **GitHub Actions** に切り替える
2. `main` へ push するか、`Actions > Docs > Run workflow` を実行する
3. `https://NAKAK10.github.io/vrev/` が 200 を返すことを確認する

権限は最小限です（`contents: read` / `pages: write` / `id-token: write`）。npm 公開用の OIDC とは独立しています。

## README への記載方法

`README.md` 冒頭に次の 3 点を置くのが本リポジトリの流儀です:

1. Docs workflow バッジ（公開の死活が一目で分かる）
2. ドキュメントサイト URL（`https://NAKAK10.github.io/vrev/`）
3. ガイドページへの相対リンク（`docs/plugin-guide.md`、`docs/site-publish.md`）

例:

```md
[![Docs](https://github.com/NAKAK10/vrev/actions/workflows/docs.yml/badge.svg)](https://github.com/NAKAK10/vrev/actions/workflows/docs.yml)

📚 ドキュメントサイト: https://NAKAK10.github.io/vrev/
```

サイト側のスクショは `docs/public/images/` に置くと、VitePress では `/vrev/images/<file>` として配信され、Markdown からは `/images/<file>` で参照できます。
