# 画面遷移マップ (page-map)

同じ公開directory配下のHTMLを静的解析し、ページ間の遷移をグラフで俯瞰するVisual Reviewプラグインです。レビュー画面のstage切り替えmenuから「画面遷移マップ」を選ぶと表示されます（stage contributionが2つ以上あるときにCoreが切り替えmenuを描画します）。

## サポート状況

| 対象 | 対応状況 |
|---|---|
| 静的HTML | 必須（対応） |
| Vue | ベストエフォート（テンプレート内の静的な`href`/`to`属性のみ） |
| React | ベストエフォート（JSX内の静的な文字列リテラルのみ） |
| Next.js | 未対応（Phase 2予定） |
| Nuxt | 未対応（Phase 2予定） |
| 動的遷移（変数・API応答・条件分岐で決まる遷移先） | 非対応 |

Phase 1（本リリース）は静的HTMLのみを対象とします。フレームワーク製の出力に対しても、ビルド後の静的HTMLとして解析できる範囲でベストエフォートに動作しますが、保証はしません。

## 何をしないか

- ページを一切開きません（iframe読み込み・ブラウザ起動・レンダリングを行いません）。
- ネットワークへ一切アクセスしません（`fetch`/`http`/`https`モジュールを使用しません）。
- スクリプトを評価しません（`eval`・`new Function`・DOMパーサーを使用しません）。
- symlinkを辿りません。隠しfileや`credential`/`secret`で始まる名前のfile/directoryもskipします。

サーバー側の解析はHTMLのテキストを正規表現ベースで走査するだけの、副作用のない純粋な静的解析です。

## 抽出する遷移

- `<a href>` / `<area href>`
- `<form action>`（`action`省略時は同一ページへの自己遷移として扱います）
- `<meta http-equiv="refresh">`
- インラインイベントハンドラ（`onclick`等）および`<script>`内の`location.href`/`location.assign`/`location.replace`/`window.open`（文字列リテラルのみ。変数や式による動的な遷移先は「解析できなかった遷移」として件数のみ報告します）
- `data-href` / `data-navigate` / `data-link`属性

## 制限

- 最大500file、file単体1MiB、解析全体5秒のいずれかを超えると、そこまでの結果に`truncated: true`と警告を付けて返します。
- 公開directoryの外（`outside`）や外部URL（`external`）へのリンクは、存在確認や内容取得を一切行わない終端ノードとして扱います。

## キャッシュ

pluginインスタンスごとにfileのmtime/sizeをキーにしたin-memory cacheを持ち、変更のないfileは再解析しません。「再解析」操作（`page-map.refresh`）でcacheを破棄します。

## Phase 2/3の予定

- Next.js/Nuxtのroutingを解釈した解析
- ビルド成果物からのroute逆引き
- クライアントサイド遷移（SPA router）の限定的な解析
