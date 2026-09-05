# 開発者ガイド

vrev は、Core と機能プラグインを組み合わせる構成です。まずは目的に合うガイドを選んでください。

## 目的から探す

| やりたいこと | ドキュメント |
| --- | --- |
| 最初のプラグインを作る | [プラグイン開発ガイド](./plugin-guide) |
| manifest と capability を理解する | [プラグイン基盤](./plugins) |
| 宣言的 UI を実装する | [UI ブリッジ](./plugin-ui-bridge) |
| Core と Host の境界を調べる | [Plugin Host アーキテクチャ](./plugin-host-architecture) |
| 保存先を拡張する | [Storage Providers](./storage-providers) |
| リリース作業をする | [リリース手順](./releasing) |
| 既知の制約を確認する | [トラブルシューティング](./gotchas) |

## プラグインの構成

現在の標準は **schema v4 Plugin Host** です。Core の宣言的レンダラーが検証済み JSON UI document を描画し、機能パッケージ間はバージョン付き Host capability で接続します。

| パッケージ | 責務 |
| --- | --- |
| `@vrev/review` | 注釈、履歴、永続化 |
| `@vrev/ai` | CLI の選択と共通 AI 実行 |
| `@vrev/annotation-workflow` | AI ジョブと自動実行ポリシー |
| `@vrev/page-map` | 静的 HTML の画面遷移解析 |
| `@vrev/github-issue` | Issue の下書き・選択・GitHub 操作 |
| `@vrev/storage-firestore` | Firestore リモートストレージ |

## 最初のプラグインを生成する

```bash
npx @vrev/cli plugin create my-plugin \
  --title "My Plugin" \
  --summary "Extend the review workflow" \
  --install

npx @vrev/cli plugin run my-plugin hello world
```

::: warning 生成される schema の違い
`plugin create` は provider/command 互換の **schema v3** を生成します。server capability や宣言的 UI を提供する場合は、[schema v4 contract](./plugins) に更新してください。
:::

開発用の型・contract は `@vrev/plugin-sdk@1.0.0-beta.2` で提供されます。

## 安全な導入と設定

- Core は `package.json` の直接依存だけを検出し、検出時にコードを評価しません。
- 設定画面から導入する npm パッケージは正確なバージョン、GitHub spec は tag / commit SHA で固定してください。
- 追加直後のプラグインは無効です。内容を確認してから有効化してください。
- API キーやトークンは環境変数や専用の認証設定を使ってください。

## 設計と今後の計画

[ロードマップ](./roadmap) · [設計判断](./decisions) · [移行計画](./plugin-migration-plan) · [公開監査](./publication-audit)
