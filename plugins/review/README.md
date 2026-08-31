# レビュー

Visual Review のレビュー集約、入力検証、schema v1→v2 migration、active/resolved transaction persistence を所有する bundled default plugin です。

既存の `ReviewStore` export と HTTP/CLI routes は compatibility façade として、この plugin-owned implementation に委譲します。保存先、schema、revision、transaction behavior は変更しません。
