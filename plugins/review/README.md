# レビュー

Visual Review のレビュー集約、入力検証、schema v1→v2 migration、active/resolved transaction persistence を所有する bundled default plugin です。

既存の `ReviewStore` export と HTTP/CLI routes は compatibility façade として、この plugin-owned implementation に委譲します。保存先、schema、revision、transaction behavior は変更しません。

UI は `review.header`（表示サイズ・選択モード・再読み込みなどの操作を提供する `ui/header.ui.json`）と `review.stage`（レビュー対象の描画領域を提供する `ui/stage.ui.json`、`ui/review.js` が同梱ブラウザモジュール）の2つのcontributionに分割しています。旧 `review.main` の単一contributionは廃止しました。

`review` plugin自身も2つのextension pointを`ui.extension_points`で宣言しています。

- `review.overlays` — レビュー対象の上に描画するオーバーレイ用。context無し（`{}`のみ）。
- `review.comment-dialog.actions` — 対象を選択してコメントを入力するダイアログの「キャンセル」右側に追加操作を差し込む場所。contextは選択中の`anchor`・`page_path`・（保存後の）`annotation_id`、フォームフィールド`comment`を公開し、contributionは`completed`イベントを`slot.emit`できます。hostは`completed`受信時にダイアログを閉じ、`session`resourceを再取得します（`github-issue`plugin参照）。
