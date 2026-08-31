# Design decisions

## Core is a minimal Plugin Host (v4 beta)

Status: accepted and implemented through migration Phase 10 for `1.1.6`.

Review persistence and validation are owned by the bundled `review` plugin; job orchestration and the complete right sidebar by `annotation-workflow`; verified external runners by `custom-command`; and Issue behavior by `github-issue`. Core retains bootstrap, plugin lifecycle, target/proxy security, declarative rendering, bridge routing, generic process supervision, and versioned SDK contracts.

Plugin UIの構造はbounded declarative JSONをCoreが描画する。加えて、manifestで`browser_module`を明示した導入済みpluginだけは、Coreが検証・配信したsame-origin ES moduleをcontribution mount後に実行できる。browser moduleはUI操作・選択UXなど宣言だけでは不足する挙動を担当し、unmount cleanupを返す。任意HTML・plugin CSS・remote scriptは引き続き許可しない。browser moduleはhost DOMへ到達できるtrusted codeであるため、未信頼pluginを導入しないことを運用境界とする。Validation and business rules are server-authoritative. UI and server contributions communicate through the transport-neutral PluginBridge.

Disabling `annotation-workflow` unmounts its right-sidebar contribution（AI一括修正・注釈・履歴）without deleting review data; `review` remains available for session/headless operations. External AI job execution accepts only opaque server-verified `runner_id` values. Raw templates are accepted only by the dedicated custom-command registration operation, never by enqueue/run operations.

The architecture, bridge contract, and completed migration record are documented in:

- `docs/plugin-host-architecture.md`
- `docs/plugin-ui-bridge.md`
- `docs/plugin-migration-plan.md`

Phases 1–10 are covered by focused manifest, host lifecycle, extraction, server, job, and declarative-renderer tests plus desktop/tablet/mobile browser acceptance. In particular, source-boundary tests keep review/workflow/Issue logic out of deprecated Core façades and prevent plugin implementations from depending on another plugin implementation. Browser acceptance verifies the declarative review/settings renderer as the default and the retained legacy route/flag rollback.

### Core-owned renderer theme tokens

Plugin UIは引き続き任意CSS・selector・HTMLを提供しない。Coreの`renderer.css`が宣言componentを一貫して描画し、色・surface・border・focusなどはsemanticな`--vr-*` custom propertyへ集約する。plugin contributionのrootには診断用の`data-plugin-id` / `data-contribution-id` / `data-slot`を付けるが、通常の見た目をplugin ID固有selectorへ依存させない。

将来theme pluginを導入する場合も、任意stylesheetを実行せず、version付きtheme providerが許可済みsemantic tokenだけをsurfaceへ返し、Coreが値形式を検証して適用する。component構造と安全境界を保ったままthemeを交換できることを不変条件とする。review画面と`/settings/plugins`は同じtoken/component stylesheetを使い、plugin固有画面にもCoreのform・list・dialog stylingを必ず適用する。

### beta.7 compatibility policy

Compatibility is deliberate, not incomplete extraction. For this one-beta deprecation/rollback line, Core retains legacy HTTP/CLI routes as adapters, root `ReviewStore` / `JobStore` / `JobManager` exports as delegating façades, and the legacy browser/settings renderer through `/legacy`, `/settings/legacy`, or `VISUAL_REVIEW_LEGACY_UI=1`. Manifest schemas v1–v3 and their provider APIs continue to parse and load alongside the default schema v4 host. Adapters may translate transport and principal context but must not duplicate domain validation or business rules. beta.7 does not remove these surfaces.

## Loopback live application proxy

HTTPの`localhost` / `127.0.0.1` / `::1`と、private networkのIP literal（`10/8`、`100.64/10`、`172.16/12`、`192.168/16`、IPv6 ULA/link-local）targetはreview serverの`/live/`配下へreverse proxyする。private hostnameをDNS解決して暗黙許可せず、明示されたprivate IPだけをtrusted local-network targetとして扱う。
同一生成元に揃えることでVue、React、WordPressなどのDOMを親reviewerから選択できる。HTML/CSS/JavaScript内のroot-relative URLと
同じportのloopback aliasを`/live/`へ書き換え、route URLをannotationの`page_path`として保存する。

public HTTPS targetも`/live/`へproxyするが、同一originで第三者scriptを実行するとlocal APIへアクセスできるため、script・form・cross-origin navigationを
強制無効化したread-only static modeに限定する。DNS解決結果をpublic addressへpinし、private/reserved address、credential、cookie/authorization転送、
cross-origin redirectを拒否する。live targetのsource hashはcontentではなく正規化URLのhashであり、実際の修正確認はbrowser再検証を必須とする。

framework source hintはVue/Nuxt、React/Next、Angular、Svelte、WordPressのdevelopment runtimeから取得できる場合だけ保存する。
absolute pathはproject-relativeな`src`、`app`、`pages`、`components`、`packages`、`wp-content`以下へ縮約し、machine固有pathをreviewへ残さない。

## Source hash checkpoints

review directory名のpath hashはtarget pathから安定した保存先IDを作るためだけに使う。annotationの`source_hash`はfile targetでは対象HTML/imageそのもののbyte列、live targetでは正規化route URLのSHA-256であり、CSSなど依存resource一式のvisual fingerprintではない。annotation作成時のhash差を恒久的な警告には使わない。

AI jobをqueueへ入れる時点で現在のhashをjob checkpointとして取り直し、coordinator起動直前に再比較する。これにより過去のannotationを現在のsourceへ適用できる一方、queue後の同時変更だけを停止できる。ただし同じpageの先行Visual Review jobがactiveな間に追加されたjobはdeferred checkpointとし、先行job終了後に初めてbaselineを確定する。先行AI編集を外部競合と誤認して後続jobを連続skipしないためである。AIが`addressed`へ変更した時点でannotationの`source_hash`も修正後sourceへ更新する。

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
CLI・最大並列数・自動実行は通常画面から除外し、AI欄右上のmenuから左上共通設定導線と同じ`/settings/plugins#annotation-workflow`へ遷移させる。
built-in adapterはOpenCode・Claude・Codex・GitHub Copilot・Piを提供する。外部AIコマンド（plugin ID: `custom-command`）はserver-owned registryへ複数登録し、browserとjob APIにはopaque `runner_id`だけを返す。
shell injectionを避けるためshellを経由せずPOSIX風にtokenizeした実行ファイルとargvを直接spawnする。promptの渡し忘れを防ぐため`{prompt}`を正確に1回必須とする。
登録前に隔離した一時directoryで応答tokenとtoolによるmarker作成を検証し、単なる終了code 0ではagentic commandとして承認しない。probe時間も保存し、15秒以上なら遅いcommandとして警告する。command文字列をreview JSON、job API response、Git管理対象へ保存しない。queue復元に必要なruntime job-stateだけはGit ignore済み領域へ保持する。
注釈の状態・種類filterも注釈欄右上のmenuから開くmodalへ移し、checkbox badgeによる複数選択とする。fresh browserの既定値は
`open`・`in_progress`・`failed`・`addressed`・`resolved`および全種類とし、選択はlocalStorageへ保持する。通常sessionはactive-onlyのまま維持し、解決済みannotationと履歴はarchive APIから取得する。解決済みannotationは対象画面上へ常時overlay表示せず、cardを選択したときだけgrayのmarkを表示する。active annotationを解決済みに変更した瞬間は選択状態も解除し、そのmarkを即時非表示にする。保存anchorが見つからない場合はfallback markを描かず、右上toastだけで通知する。履歴は最新順に24件だけ初回取得し、以降は利用者が「さらに読み込む」を押した場合に限り24件ずつ追加取得する。scroll到達による自動追加は行わない。返信・注釈保存などのtext actionはmacOSの`Command+Enter`とWindows/Linuxの`Ctrl+Enter`を同じ処理へ割り当て、IME変換中は発火させない。

小規模batch（5件以下）または同一file中心ではsubagent起動のoverheadを避け、親coordinatorが指摘へ直接必要な最小限の共有編集を1回で行う。特定PCのtool名へ依存せず、利用可能なbrowser確認手段による検証をpage pathとviewportの組み合わせごとにまとめ、完了したannotationのmessage/status更新をbatch末尾まで保留しない。

jobをqueueへ登録したannotationは`in_progress`へ変更する。coordinatorが終了code 0で正常終了した実行中jobは、AI側のmessage/status更新が漏れても成功として`addressed`へ補正する。完了messageがない場合は処理完了とhuman verificationが必要なことを示す中立messageを追加する。非zero終了、timeout、spawn失敗、page unavailable、起動前source conflictは失敗またはskipのまま保持する。ただしtimeout・output limit・cancel等より前にAI completion messageまたはIssue draftが永続化済みなら、そのdurable evidenceをprocess終了理由より優先し、完了済みannotationを`failed`へ戻さない。Piはevent streamではなくfinal text modeで起動し、stderr diagnosticsをresult parserとstdout上限から分離する。旧job-stateに残るpostcondition失敗へ遅れて完了messageが届いた場合も互換性のため成功へ回復する。失敗・起動前skip時は理由message付きの`failed`、cancel時は`open`へ戻し、
server restart時もactive jobのない孤立した`in_progress`を`open`へ回復する。これによりannotation statusだけでAI対応中かを判断できる。humanは全active statusから`resolved`へ強制変更できるが、通常flowの`addressed`以外では誤操作を避ける確認dialogを必須とする。

## Compatibility and trust boundary

review保存先、schema v2、schema 1 migration、status/event規則は既存review dataと互換に保つ。
同じreview directoryを複数serverが同時所有しないよう`.server-lease.json`で起動を排他する。

`--allow-scripts`は信頼済みlocal prototype専用である。AI一括修正は通常運用を優先してCLI既定で有効とする。
対象scriptを許可した状態でもAI修正を止めたい場合は、`--no-ai-jobs-with-scripts`で明示的に無効化できる。loopback/private-network proxyは`/live/` baseを注入し、JavaScript全体の文字列置換ではなくmodule import・network URL・location bridgeだけを変換する。これによりSPA route文字列や正規表現を壊さず、root-relative assetは未知route fallbackでupstreamへ転送する。loopback targetは信頼済みappとして外部style・font・API・WebSocketを許可するが、public targetの厳格なCSPは緩和しない。
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

## Phase 10 release and publication policy

`1.1.6` ships the Core-owned declarative renderer as the default with the bundled `review` plugin providing the default review surface. Release acceptance requires matching root/lock versions, `npm test`, `npm pack --dry-run`, `git diff --check`, desktop/tablet/mobile browser verification, and verification of both legacy routes and the environment rollback switch. A dry-run pack is inspected only; no tarball is retained in the repository.

Root and standalone plugin publication is non-atomic. Because the root package bundles compatible default server/UI copies, a standalone registry failure does not break initial startup. Recovery is to retain the published root, rerun publication after fixing the failed plugin, and let the workflow skip package versions already present. Never republish or overwrite an existing version.

## Automatic installation of first-party runtime plugins

`visual-review serve`は、workspace registryに存在しない`review`、`github-issue`、`custom-command`、`annotation-workflow`をCLI package内のschema-v4同梱コピーから自動installする。plugin実体とregistryは意図的にGit管理外であり、repository差分だけを別環境へ持ち込んだ場合に手動setupを要求しないためである。network経由の自動取得はregistry認証・version drift・供給元変更に左右されるため行わず、build時に検証済みplugin server/UI assetを`dist/plugins/`へcopyする。pluginのESM境界をworkspace側のpackage typeから独立させるため、各pluginの`package.json`も同梱する。

同じplugin IDが既に導入済みでも、registry sourceが同じCLI package内bundled pathを指し、registry manifestとinstalled manifestが一致してprovenanceを確認できるtrusted copyに限り、同梱manifestのschemaまたはSemVerが新しければserver/UIをatomic upgradeする。same-IDのlocal/third-party source、manifest改変copy、同版以上は上書きせず、明示導入されたworkspace固有の選択を尊重する。UI起動時に自動評価する`annotation-workflow`は、installed manifestとmodule digestがCLI package内のbundled copyに一致する場合だけ実行する。同じIDのworkspace overrideを無断実行せず、自動修正をfail closedにする。GitHub CLIの認証やcustom commandの登録もcredential・利用者選択を伴うため自動化しない。

## Annotation post-save flow as a default plugin

注釈本文・anchor・source hashの検証、atomic保存、status遷移は`review` pluginが所有し、job enqueue・recovery・coordinator policyは`annotation-workflow` pluginがcapability経由で所有する。Coreはgeneric lifecycle、bridge、process制限だけを担当する。保存後にどのeventで自動実行を予約するか、何msまとめるか、設定UIへどのrunner候補・並列範囲・自動実行toggleを表示するかは`annotation-workflow`の運用policyである。Coreは任意HTML・remote scriptを受け取らず、検証済みJSON documentを描画する。manifestで明示されたlocal `browser_module`だけはtrusted UI runtimeとしてmount/unmountする。`annotation-workflow`が無効・利用不能なときはAI一括修正・注釈・履歴を含む右sidebar全体を表示せず、review stageを全幅へ広げ、新規enqueueもserver側で拒否する。`custom-command`を無効化した時点で登録内容は保持するがrunner候補から除外し、built-in runnerは維持する。plugin設定の保存結果はtoastで通知し、意図的な無効化をload errorとして表示しない。

## Backend-neutral storage contract

storage pluginはbackend I/Oとopaque versionによるcompare-and-swapだけを担当する。review schema・migration・mutationとlocal repository境界は`review` pluginが所有し、Firestore `updateTime`、MySQL/PostgreSQL row version、local digestを同じ`WorkspaceStorageProviderV1`へ写像する。現行Firebase pluginの直接file push/pullはlive authoritative storeではなくlegacy同期機能である。authoritative remote storageを有効化する前に、review aggregateをsingle canonical CAS keyにするかtransaction manifest方式にするかを決定する。

## AI-authored GitHub Issues for large changes

注釈dialogには通常保存と並列して`GitHub Issueにする`を置く。buttonはform submitにせず、click時だけ動作するため`Command/Ctrl+Enter`の注釈保存挙動は変えない。click後は元modalを即時閉じると同時に、Issue専用annotationを注釈一覧へ`未対応`で保存する。Issueラフ生成は独自AI processを起動せず、通常annotationと同じAI queue・選択中CLI・対象Git repositoryのworking directoryを使う。このため`注釈を保存したら自動でAI修正を開始`が有効なら自動開始し、無効ならhumanがAI一括修正を押すまで未対応のまま待つ。queue後は`Issue作成中`、ラフ完成後は`AI対応済み`、GitHub作成後は`Issue作成済み`へ遷移する。失敗時は通常jobと同じ`失敗`にしてcardへ`Issueラフを再実行`を表示する。再実行も自動実行設定に従う。coordinatorは対象repositoryとpage sourceをread-onlyで調査し、画像に依存せずrepository-relative pathを含むtitle/bodyへ整理するが、GitHubへの作成は行わない。Issue用annotationではCLIごとのtool実行能力へ依存せず、最終応答の`VISUAL_REVIEW_ISSUE_DRAFT_START` / `VISUAL_REVIEW_ISSUE_DRAFT_END`間に1行JSONを返し、host側が対象batchのannotation IDだけを検証して保存する。これによりOllama経由などのcustom CLIでもnested annotation CLIを実行できないことを理由に失敗させない。Issueは単体で初めて読む実装者にも理解できる内容にし、annotation ID、review file path、`.vreview`、`Visual Review注釈`など内部review情報をtitle/bodyへ露出させない。storeもこれらの内部参照を含むAI draftを拒否する。ラフ完成後は`AI対応済み`cardのclickで編集modalを開き、humanがtitle/bodyを修正して`Command/Ctrl+Enter`またはbuttonで初めて、対象Git repositoryをcwdとして`gh issue create`を実行する。modalの連続click・shortcut連打はclient側in-flight lockとserver側annotation単位のsingle-flightで同じ作成Promiseへ集約し、作成済みannotationへの再送は保存済みURLを返すため、GitHub Issueは1件だけ作成される。実際の`gh issue create`、draft検証、single-flightは`github-issue` pluginが担当し、review stateはReview capability経由で更新する。plugin未導入時はinstall方法を含むエラーを返す。作成完了時は対象iframeやsession全体をreloadせず、responseのactive reviewだけを差分反映する。また元注釈のthreadと`updated_at`は変更せず、Issue URL・title・状態だけを記録する。現在の注釈filter選択はhumanの明示設定として保持し、Issue作成後に`解決済み`を自動追加するなどsystem側から変更しない。作成後は同じ専用annotationへIssue URL/titleを付与して`resolved` archiveへ移し、通常AI修正には入れない。cardからIssueを特定できれば十分で、GitHub側のclose/reopen状態は追跡しない。保存nodeが後から見つからなくてもfallback overlayは出さず、pathとIssue linkを記録として使う。target scriptから任意のAI/gh実行を起動できないよう、AI jobs無効modeではIssue APIも無効にする。

## Modal operation feedback

modal内の長時間commandは開始時に所要時間を通知し、対象buttonを`aria-busy`かつdisabledにして処理中labelを表示する。成功・失敗toastはmodal backdropより下になる通常fixed layerへ置かず、open dialogの`.vr-dialog-body`先頭へsticky statusとして描画する。native modal dialogは別top-layer popoverより上に残るbrowserがあるため、dialog自身の子要素にする。toast stateはDOM外で保持し、renderer rerender後にmicrotaskとanimation frameで再描画する。infoは7秒、成功・失敗は12秒表示する。

## External runner extension point

外部AIコマンドは`runner-registry/v1`を所有し、runner descriptor列挙、opaque runner IDからshell-free command specへの解決、他AI pluginのprovider登録・解除を提供する。runner登録は隔離directoryでcapability testを先に完了させ、成功したrunnerだけをatomicに保存する。失敗時は設定を変更せず、未検証runnerを登録済み一覧や注釈ワークフロー候補へ露出しない。注釈ワークフローはこれをoptional dependencyとして受け付け、built-in runnerと外部runnerを設定UIで合成する。plugin間ではraw command templateを渡さず、選択値は`custom:<opaque runner_id>`、実行時連携はversioned capabilityだけを使う。外部AIコマンドが無効・未導入・runner未検証の場合はbuilt-in runnerだけで継続する。

## Selection mode listener lifecycle

node/region/browseのmode変更ではtarget iframeを維持しつつ、旧modeのcapture listenerを必ずremoveしてから新modeのlistenerをinstallする。documentにcleanup handleを1つだけ保持し、同一modeの重複installは行わない。これによりregionからnodeへ切り替えた後に旧pointer listenerが範囲注釈を作る競合を防ぐ。

review treeの部分patchではtarget iframe以外のoverlay DOMが置換されるため、main browser moduleもcleanup後に接続中のcontribution rootへ再mountする。hover枠が切り離された旧annotation layerへ描画されることを防ぎ、node modeのたびに現在のlayerへ追従させる。iframe読込初期に`documentElement`が未生成の場合は短時間後にinstallを再試行する。

## Annotation target visibility

sidebarの現在のstatus/kind filterを通過したannotationだけを、node/regionともcurrent target上へborder＋translucent fillで表示する。右側一覧から除外されたannotationはtargetにも描画しない。状態色は未対応=amber、AI対応中=blue、失敗=red、AI対応済み=green、解決済み=grayとし、node hoverはblue、region previewはpurpleに分離する。live proxyのcurrent pageは`/live/...`ではなく元の`live_url`を基準にcanonical URLへ戻してannotationの`page_path`と比較する。sidebarのannotation card全体、annotation title、「対象を表示」はいずれもtarget focus actionとし、クリックまたはcardへのkeyboard操作でannotation IDを同じ状態色の太いselected markとして強調して対象位置へscrollする。card内の返信入力・button・link等のinteractive controlは本来の操作を優先し、親cardへのclick伝播ではfocusを重複実行しない。

## Auto-run and manual batch exclusivity

annotation workflowの`auto_run`が有効な場合、注釈保存時に自動enqueueされるため、メイン画面の「AIにまとめて修正依頼」は表示しない。`auto_run`が無効な場合だけmanual batch buttonを表示し、同じ注釈を意図せず重複enqueueする導線を作らない。

## Optimistic command retry

宣言的UI commandが`expected_revision`付きで`CONFLICT`を受けた場合、rendererはそのrevision bindingが参照するresourceを再取得し、新しいrequest/idempotency keyで1回だけ再実行する。pollingやAI jobの同時更新直後でも、人間のannotation作成・返信・status操作を生の`review revision conflict`で失敗させない。revision指定のないsemantic conflictはretryせず、2回目の競合もplugin errorとして返す。

## Plugin management discoverability

review header左上の「設定」は新規workspaceでも既定表示する。plugin管理を隠す必要があるworkspaceだけ`.vreview/settings.json`へ`ui.plugin_management: false`を明示する。設定導線が存在しないままbuilt-in pluginの状態や外部AI commandを変更できなくなる構成をdefaultにしない。

## Script-free target navigation

local HTMLをsafe modeで表示するとtarget scriptは実行しないが、desktop CSSで可視になったnavigationが初期`inert`のまま残る場合がある。review browser moduleは閲覧modeに限り、viewport内で可視かつanchorを含む`inert` subtreeを一時的にinteractiveへ戻す。node/region modeでは変更せず、runtime cleanup時に元の`inert`と`aria-hidden`を復元する。これにより任意target scriptを許可せず、通常anchor navigationだけを利用可能にする。

## Compact review chrome

review対象を広く表示するため、desktop headerは56pxを基準とする。閲覧・ノード・範囲はselectへ畳まず横並びのsegmented controlsとして常時表示し、`V`・`N`・`R`をそれぞれのショートカットにする。入力欄・select・contenteditable・dialog操作中は発火させない。annotation filter、thread、statusなどsidebarだけの変更ではtarget stageとiframe DOMを再生成せず、stageを現在のDOM位置へ接続したままheader・sidebar・overlay・dialogだけを差し替えてscroll・page state・対象DOMを保持する。iframe要素を同じsurface内で移動するだけでもbrowserがdocumentを再loadしてscrollを失うため、stageのdetach・reparentも禁止する。target identityが変わった場合だけstageを作り直す。annotation list section自体のpadding・cardの角丸・shadow・全周borderは使わず、各rowを1pxの横罫線で区切る。statusはlabelで表現し、情報量を減らさず装飾による占有だけを削る。

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
