# Gotchas and known constraints

- Windowsのcoordinator cancelで使う`taskkill`は実機未検証。
- OpenCode / Claude / Codex CLIのversion差により、session引継ぎやoptionがdriftする可能性がある。
- browser E2Eは未整備。HTTP/unit testに加え、対象viewportでの手動確認が必要。
- AI一括修正はCLI既定で有効。trusted `--allow-scripts` modeで意図的にAI修正を止める場合は`--no-ai-jobs-with-scripts`を指定する。
- TypeScript生成の`jobs.js`末尾には`export {}`が入るため、HTMLでは必ず`type="module"`で読み込む。通常scriptに戻すとAI一括修正UIが初期化されず、未対応件数が0のままになる。
- 同じreview directoryを対象とするserverは共通leaseを使うため同時起動できない。
- 外部projectも`.code/htmls/`または`assets/`という公開target配置規則に従う必要がある。
