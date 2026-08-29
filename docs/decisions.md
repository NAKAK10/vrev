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

## Source hash checkpoints

review directory名のpath hashはtarget pathから安定した保存先IDを作るためだけに使う。annotationの`source_hash`はfile targetでは対象HTML/imageそのもののbyte列、live targetでは正規化route URLのSHA-256であり、CSSなど依存resource一式のvisual fingerprintではない。annotation作成時のhash差を恒久的な警告には使わない。

AI jobをqueueへ入れる時点で現在のhashをjob checkpointとして取り直し、coordinator起動直前に再比較する。これにより過去のannotationを現在のsourceへ適用できる一方、queue後の同時変更だけを停止できる。AIが`addressed`へ変更した時点でannotationの`source_hash`も修正後sourceへ更新する。

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
built-in adapterはOpenCode・Claude・Codex・GitHub Copilot・Piを提供する。カスタムコマンドはbrowser localStorageへ複数登録できるが、
shell injectionを避けるためshellを経由せずPOSIX風にtokenizeした実行ファイルとargvを直接spawnする。promptの渡し忘れを防ぐため`{prompt}`を正確に1回必須とする。
登録前に隔離した一時directoryで応答tokenとtoolによるmarker作成を検証し、単なる終了code 0ではagentic commandとして承認しない。probe時間も保存し、15秒以上なら遅いcommandとして警告する。command文字列をreview JSONやGit管理対象へ保存しない。queue復元に必要なruntime job-stateだけはGit ignore済み領域へ保持する。
注釈の状態・種類filterも注釈欄右上のmenuから開くmodalへ移し、checkbox badgeによる複数選択とする。fresh browserの既定値は
`open`・`in_progress`・`failed`・`addressed`および全種類で、`resolved`は明示的に選択した場合だけ表示する。選択はlocalStorageへ保持する。

小規模batch（5件以下）または同一file中心ではsubagent起動のoverheadを避け、親coordinatorが指摘へ直接必要な最小限の共有編集を1回で行う。特定PCのtool名へ依存せず、利用可能なbrowser確認手段による検証をpage pathとviewportの組み合わせごとにまとめ、完了したannotationのmessage/status更新をbatch末尾まで保留しない。

jobをqueueへ登録したannotationは`in_progress`へ変更する。coordinator成功時は`addressed`、失敗・起動前skip時は理由message付きの`failed`、cancel時は`open`へ戻し、
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

## Workspace storage and monorepos

review dataは最寄りのGit root（Git管理外では実行directory）の`.vreview/`へ集約する。`--project-root`は省略可能で、
通常は実行directoryをproject contextとして使う。monorepo childから起動した場合はworkspace rootをAIのworking directoryとし、
child pathを`.vreview/settings.json`へrepository相対pathで登録する。基本的なroot検出は決定的に行い、初回AI coordinatorは同じ実行内で
manifest・route・source hintからprimary projectとshared scopeを調査して`context.json`を更新する。

active annotation（`open`・`in_progress`・`failed`・`addressed`）は`review.json`、humanが解決したannotationは`resolved.json`へ分離する。
APIは両方をmergeして従来どおり1つのreviewとして返し、再open時はactive JSONへ戻す。annotation orderとglobal revisionを両ファイルへ持たせ、
status移動後もUI順序とevent履歴を維持する。旧`.code/visual-reviews`のreviewはtargetを開いた時点で新storageへ移行する。

## External projects

別repositoryを対象にする場合だけ`--project-root`を明示する。packageを対象projectへ複製せず、同じschemaと安全なpath規則を再利用できる。
