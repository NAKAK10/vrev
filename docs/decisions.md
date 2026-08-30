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
`open`・`in_progress`・`failed`・`addressed`・`resolved`および全種類とし、選択はlocalStorageへ保持する。通常sessionはactive-onlyのまま維持し、解決済みannotationと履歴はarchive APIから取得する。解決済みannotationは対象画面上へ常時overlay表示せず、cardを選択したときだけgrayのmarkを表示する。active annotationを解決済みに変更した瞬間は選択状態も解除し、そのmarkを即時非表示にする。保存anchorが見つからない場合はfallback markを描かず、右上toastだけで通知する。履歴は最新順に24件だけ初回取得し、以降は利用者が「さらに読み込む」を押した場合に限り24件ずつ追加取得する。scroll到達による自動追加は行わない。返信・注釈保存などのtext actionはmacOSの`Command+Enter`とWindows/Linuxの`Ctrl+Enter`を同じ処理へ割り当て、IME変換中は発火させない。

小規模batch（5件以下）または同一file中心ではsubagent起動のoverheadを避け、親coordinatorが指摘へ直接必要な最小限の共有編集を1回で行う。特定PCのtool名へ依存せず、利用可能なbrowser確認手段による検証をpage pathとviewportの組み合わせごとにまとめ、完了したannotationのmessage/status更新をbatch末尾まで保留しない。

jobをqueueへ登録したannotationは`in_progress`へ変更する。coordinatorが終了code 0で正常終了した実行中jobは、AI側のmessage/status更新が漏れても成功として`addressed`へ補正する。完了messageがない場合は処理完了とhuman verificationが必要なことを示す中立messageを追加する。非zero終了、timeout、spawn失敗、page unavailable、起動前source conflictは失敗またはskipのまま保持する。旧job-stateに残るpostcondition失敗へ遅れて完了messageが届いた場合も互換性のため成功へ回復する。失敗・起動前skip時は理由message付きの`failed`、cancel時は`open`へ戻し、
server restart時もactive jobのない孤立した`in_progress`を`open`へ回復する。これによりannotation statusだけでAI対応中かを判断できる。humanは全active statusから`resolved`へ強制変更できるが、通常flowの`addressed`以外では誤操作を避ける確認dialogを必須とする。

## Compatibility and trust boundary

review保存先、schema v2、schema 1 migration、status/event規則は既存review dataと互換に保つ。
同じreview directoryを複数serverが同時所有しないよう`.server-lease.json`で起動を排他する。

`--allow-scripts`は信頼済みlocal prototype専用である。AI一括修正は通常運用を優先してCLI既定で有効とする。
対象scriptを許可した状態でもAI修正を止めたい場合は、`--no-ai-jobs-with-scripts`で明示的に無効化できる。loopback proxyは`/live/` baseを注入し、JavaScript全体の文字列置換ではなくmodule import・network URL・location bridgeだけを変換する。これによりSPA route文字列や正規表現を壊さず、root-relative assetは未知route fallbackでupstreamへ転送する。loopback targetは信頼済みappとして外部style・font・API・WebSocketを許可するが、public targetの厳格なCSPは緩和しない。
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

## AI-authored GitHub Issues for large changes

注釈dialogには通常保存と並列して`GitHub Issueにする`を置く。buttonはform submitにせず、click時だけ動作するため`Command/Ctrl+Enter`の注釈保存挙動は変えない。click後は元modalを即時閉じると同時に、Issue専用annotationを注釈一覧へ`未対応`で保存する。Issueラフ生成は独自AI processを起動せず、通常annotationと同じAI queue・選択中CLI・対象Git repositoryのworking directoryを使う。このため`注釈を保存したら自動でAI修正を開始`が有効なら自動開始し、無効ならhumanがAI一括修正を押すまで未対応のまま待つ。queue後は`Issue作成中`、ラフ完成後は`AI対応済み`、GitHub作成後は`Issue作成済み`へ遷移する。失敗時は通常jobと同じ`失敗`にしてcardへ`Issueラフを再実行`を表示する。再実行も自動実行設定に従う。coordinatorは対象repositoryとpage sourceをread-onlyで調査し、画像に依存せずrepository-relative pathを含むtitle/bodyへ整理するが、GitHubへの作成は行わない。Issue用annotationではCLIごとのtool実行能力へ依存せず、最終応答の`VISUAL_REVIEW_ISSUE_DRAFT_START` / `VISUAL_REVIEW_ISSUE_DRAFT_END`間に1行JSONを返し、host側が対象batchのannotation IDだけを検証して保存する。これによりOllama経由などのcustom CLIでもnested annotation CLIを実行できないことを理由に失敗させない。Issueは単体で初めて読む実装者にも理解できる内容にし、annotation ID、review file path、`.vreview`、`Visual Review注釈`など内部review情報をtitle/bodyへ露出させない。storeもこれらの内部参照を含むAI draftを拒否する。ラフ完成後は`AI対応済み`cardのclickで編集modalを開き、humanがtitle/bodyを修正して`Command/Ctrl+Enter`またはbuttonで初めて、対象Git repositoryをcwdとして`gh issue create`を実行する。modalの連続click・shortcut連打はclient側in-flight lockとserver側annotation単位のsingle-flightで同じ作成Promiseへ集約し、作成済みannotationへの再送は保存済みURLを返すため、GitHub Issueは1件だけ作成される。作成完了時は対象iframeやsession全体をreloadせず、responseのactive reviewだけを差分反映する。また元注釈のthreadと`updated_at`は変更せず、Issue URL・title・状態だけを記録する。現在の注釈filter選択はhumanの明示設定として保持し、Issue作成後に`解決済み`を自動追加するなどsystem側から変更しない。作成後は同じ専用annotationへIssue URL/titleを付与して`resolved` archiveへ移し、通常AI修正には入れない。cardからIssueを特定できれば十分で、GitHub側のclose/reopen状態は追跡しない。保存nodeが後から見つからなくてもfallback overlayは出さず、pathとIssue linkを記録として使う。target scriptから任意のAI/gh実行を起動できないよう、AI jobs無効modeではIssue APIも無効にする。

## Compact review chrome

review対象を広く表示するため、desktop headerは56pxを基準とする。annotation list section自体のpadding・cardの角丸・shadow・全周borderは使わず、各rowを1pxの横罫線で区切る。statusはlabelで表現し、情報量を減らさず装飾による占有だけを削る。

## Static target refresh after AI fixes

local static HTMLにはframeworkのHMRがないため、current page上のannotationが新たに`addressed`へ遷移したことをsession pollingで検出したら、reviewer iframeを自動reloadする。CSS/JavaScriptだけの修正でもHTTPの`no-store`により最新resourceを取得できる。reload前のscroll座標は復元し、別pageの修正では閲覧中pageを動かさない。Vue/React等のloopback live targetはframework側のHMRと競合させないため、この自動reloadの対象外とする。

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
通常sessionとjob managerはactive-only readを使い、polling payloadを小さく保つ。reviewerは別のarchive APIから解決済みannotationを取得してfilter・card・overlay・件数へ含め、履歴だけは24件単位でpage取得する。mutationは互換性のため両fileをmergeして対象を検索するので、annotation IDを指定したhumanの再openや返信はresolved archiveからactive JSONへ戻せる。annotation orderとglobal revisionを両ファイルへ持たせ、status移動後も順序とevent履歴を維持する。旧`.code/visual-reviews`のreviewはtargetを開いた時点で新storageへ移行する。

## External projects

別repositoryを対象にする場合だけ`--project-root`を明示する。packageを対象projectへ複製せず、同じschemaと安全なpath規則を再利用できる。
