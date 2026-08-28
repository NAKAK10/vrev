# Design decisions

## One coordinator per batch

AI一括修正は、annotationごとにjob recordを作りつつ、batch全体では1つのcoordinator
CLIだけを起動する。coordinatorが依存関係、編集順、検証結果を一元管理でき、複数process
が同じ修正を競合して適用することを防ぐためである。

`max_parallel`はread-only subagent調査の上限に限定する。共有working treeで複数writerを
走らせると、互いの未commit変更を上書きしたり、不完全な状態を検証したりするため、編集は
親coordinatorだけが順次行う。

## Compatibility and trust boundary

review保存先、schema v2、schema 1 migration、status/event規則は既存review dataと互換に保つ。
同じreview directoryを複数serverが同時所有しないよう`.server-lease.json`で起動を排他する。

`--allow-scripts`は信頼済みlocal prototype専用である。対象scriptからAI processを意図せず起動する
経路を作らないため、このmodeでは既定でjobs APIとUIのAI一括修正を無効にする。動的UIとAI修正を
併用する場合は、対象コードを完全に信頼したうえで`--allow-ai-jobs-with-scripts`を追加する二段階の明示許可とする。

## Coordinator sessions are CLI-owned

UIではSession IDやAttach URLを入力させず、batchごとに選択したCLIがfresh coordinator sessionを自動作成する。
OpenCode / Claude / Codexのsession IDは相互互換ではなく、存在しないIDを生成してresume指定すると失敗するため、
Visual Review側ではIDを捏造しない。HTTP APIの`session_id`と`opencode_attach`は既存client互換のため当面受理するが、標準UIは送信しない。

## Responsive viewport switching

HTML reviewはPC（stageの利用可能幅）、タブレット768px、スマホ390pxを同じiframeで切り替える。
別pageや別reviewを作らず、annotationのpage pathとDOM anchorを共通利用することで、同じ指摘を各responsive layoutで
再確認できる。切替後はiframeのresizeとoverlay再描画を行い、画像reviewではviewport controlsを無効にする。

## Annotation focus restores transient UI context

注釈カードを選んだとき、対象ノードが閉じたdialog、popover、details、`hidden` / `aria-hidden`
のcontrolled panel内にあれば、保存済みselectorから対象を解決した後にその祖先UIを再表示する。
`aria-controls`または`data-open-layer`で対応するopenerを特定できる場合はclickして対象側の正規state
遷移を使い、見つからない場合だけvisibility属性を復元する。特定prototypeのmodal IDは保存・
ハードコードせず、反対に常時表示が正しい画面にも影響させない。

## External projects

build済みCLIに`--project-root`を明示し、targetをそのrootからのPOSIX相対pathで渡す設計と
した。packageを対象projectへ複製せず、同じschemaと安全なpath規則を再利用できる。
