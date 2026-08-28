# Design decisions

## Loopback live application proxy

HTTPの`localhost` / `127.0.0.1` / `::1` targetはreview serverの`/live/`配下へreverse proxyする。
同一生成元に揃えることでVue、React、WordPressなどのDOMを親reviewerから選択できる。HTML/CSS/JavaScript内のroot-relative URLと
同じportのloopback aliasを`/live/`へ書き換え、route URLをannotationの`page_path`として保存する。

public HTTPS targetも`/live/`へproxyするが、同一originで第三者scriptを実行するとlocal APIへアクセスできるため、script・form・cross-origin navigationを
強制無効化したread-only static modeに限定する。DNS解決結果をpublic addressへpinし、private/reserved address、credential、cookie/authorization転送、
cross-origin redirectを拒否する。live targetのsource hashはcontentではなく正規化URLのhashであり、実際の修正確認はbrowser再検証を必須とする。

framework source hintはVue/Nuxt、React/Next、Angular、Svelte、WordPressのdevelopment runtimeから取得できる場合だけ保存する。
absolute pathはproject-relativeな`src`、`app`、`pages`、`components`、`packages`、`wp-content`以下へ縮約し、machine固有pathをreviewへ残さない。

## Automatic port selection

serverは`18765`を既定の開始ポートとし、`EADDRINUSE`の場合だけ次の番号を65535まで順に試す。
`--port`は固定値ではなく探索開始値として扱う。複数projectを同時起動するときに手動でportを管理させないためである。
同じreviewの二重起動はport探索より前にserver leaseで拒否し、別project／別targetだけが別portへ進む。

## One coordinator per batch

AI一括修正は、annotationごとにjob recordを作りつつ、batch全体では1つのcoordinator
CLIだけを起動する。coordinatorが依存関係、編集順、検証結果を一元管理でき、複数process
が同じ修正を競合して適用することを防ぐためである。

`max_parallel`は1〜10のread-only subagent調査上限に限定する。共有working treeで複数writerを
走らせると、互いの未commit変更を上書きしたり、不完全な状態を検証したりするため、編集は
親coordinatorだけが順次行う。自動実行modeは注釈作成eventを300ms debounceして新規open annotationをqueueへ追加し、
既存batch実行中でも次batchとして待機させる。自動実行の選択はbrowser localStorageへ保持し、有効時は手動実行buttonを隠す。
CLI・最大並列数・自動実行は通常画面を圧迫しないよう、AI欄右上のmenuから開くsettings modalへ集約する。

jobをqueueへ登録したannotationは`in_progress`へ変更する。coordinator成功時は`addressed`、失敗・cancel・起動前skip時は`open`へ戻し、
server restart時もactive jobのない孤立した`in_progress`を`open`へ回復する。これによりannotation statusだけでAI対応中かを判断できる。

## Compatibility and trust boundary

review保存先、schema v2、schema 1 migration、status/event規則は既存review dataと互換に保つ。
同じreview directoryを複数serverが同時所有しないよう`.server-lease.json`で起動を排他する。

`--allow-scripts`は信頼済みlocal prototype専用である。AI一括修正は通常運用を優先してCLI既定で有効とする。
対象scriptを許可した状態でもAI修正を止めたい場合は、`--no-ai-jobs-with-scripts`で明示的に無効化できる。
public targetでは`--allow-scripts`を受理せず、対象scriptからlocal APIやAI processへ到達する経路を作らない。

## Coordinator sessions are CLI-owned

UIではSession IDやAttach URLを入力させず、batchごとに選択したCLIがfresh coordinator sessionを自動作成する。
OpenCode / Claude / Codexのsession IDは相互互換ではなく、存在しないIDを生成してresume指定すると失敗するため、
Visual Review側ではIDを捏造しない。HTTP APIの`session_id`と`opencode_attach`は既存client互換のため当面受理するが、標準UIは送信しない。

## Responsive viewport switching

HTML reviewはPC（stageの利用可能幅）、タブレット768px、スマホ390pxを同じiframeで切り替える。
別pageや別reviewを作らず、annotationのpage pathとDOM anchorを共通利用することで、同じ指摘を各responsive layoutで
再確認できる。切替後はiframeのresizeとoverlay再描画を行い、画像reviewではviewport controlsを無効にする。
annotationにはviewport寸法だけでなく`viewport_mode`も保存し、AI coordinatorへ同じmodeでの修正・検証を要求する。

## Annotation focus restores transient UI context

注釈カードを選んだとき、対象ノードが閉じたdialog、popover、details、`hidden` / `aria-hidden`
のcontrolled panel内にあれば、保存済みselectorから対象を解決した後にその祖先UIを再表示する。
`aria-controls`または`data-open-layer`で対応するopenerを特定できる場合はclickして対象側の正規state
遷移を使い、見つからない場合だけvisibility属性を復元する。特定prototypeのmodal IDは保存・
ハードコードせず、反対に常時表示が正しい画面にも影響させない。

## External projects

build済みCLIに`--project-root`を明示し、targetをそのrootからのPOSIX相対pathで渡す設計と
した。packageを対象projectへ複製せず、同じschemaと安全なpath規則を再利用できる。
