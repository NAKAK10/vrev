# レビュー

Visual Review のレビュー集約、入力検証、schema v1→v2 migration、active/resolved transaction persistence を所有する bundled default plugin です。

既存の `ReviewStore` export と HTTP/CLI routes は compatibility façade として、この plugin-owned implementation に委譲します。保存先、schema、revision、transaction behavior は変更しません。

UI は `review.header`（表示サイズ・選択モード・再読み込みなどの操作を提供する `ui/header.ui.json`）と `review.stage`（レビュー対象の描画領域を提供する `ui/stage.ui.json`、`ui/review.js` が同梱ブラウザモジュール）の2つのcontributionに分割しています。旧 `review.main` の単一contributionは廃止しました。
