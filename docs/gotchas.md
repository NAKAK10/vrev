# Gotchas and known constraints

- Windowsのcoordinator cancelで使う`taskkill`は実機未検証。
- OpenCode / Claude / Codex CLIのversion差により、session引継ぎやoptionがdriftする可能性がある。
- beta.7の宣言的review/settings surfaceはdesktop/tablet/mobileのbrowser acceptanceを完了している。ただしVue/React/WordPressのfixtureをCIで自動実行するbrowser E2Eは未整備であり、localhost framework/HMR変更時は対象fixtureで再確認する。
- AI一括修正はCLI既定で有効。trusted `--allow-scripts` modeで意図的にAI修正を止める場合は`--no-ai-jobs-with-scripts`を指定する。
- TypeScript生成の`jobs.js`末尾には`export {}`が入るため、HTMLでは必ず`type="module"`で読み込む。通常scriptに戻すとAI一括修正UIが初期化されず、未対応件数が0のままになる。
- 同じreview directoryを対象とするserverは共通leaseを使うため同時起動できない。
- 外部projectも`.code/htmls/`または`assets/`という公開target配置規則に従う必要がある。
- Plugin Host v4 betaのjob enqueue/run境界はserver-side verifiedなopaque `runner_id`だけを受理し、raw command templateやunknown fieldを拒否する。templateは専用のcustom-command登録operationだけが受理する。旧job-stateのraw fieldは読取り互換に限り、API responseから除外する。
- beta.7ではrollback用の旧rendererを`/legacy`、`/settings/legacy`、`VISUAL_REVIEW_LEGACY_UI=1`でone-beta lineだけ保持する。legacy HTTP/CLI routesとroot `ReviewStore` / `JobStore` / `JobManager` exportsも同期間のadapter/façadeであり、新規利用を増やさない。
- plugin manifest schema v4がdefaultだが、schema v1–v3と既存provider APIはdeprecation line中もsupported compatibility inputである。互換adapterへvalidationやbusiness ruleを戻すとplugin-owned authorityが二重化するため禁止する。
- import-boundary/extraction testsはCore façade内のdomain logicとplugin間implementation importを検査するが、Node server plugin自体は利用者権限で動くtrusted codeでありOS-level sandboxではない。
- declarative rendererのunit/integration coverageに加え、desktop/tablet/mobileとlegacy route/flagのbrowser acceptanceはPhase 10で完了した。代表framework fixtureの自動E2Eはlocalhost application modeの将来項目として残る。
- authoritative remote review storageのaggregate atomicity方式は未決定。Firebaseの既存snapshot push/pullを交換可能なlive authoritative storeとみなさない。
