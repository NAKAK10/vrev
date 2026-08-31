# Visual Review GitHub Issue plugin

Visual ReviewのIssue draftを、対象repositoryでGitHub CLI (`gh`)を使ってGitHub Issueとして作成するproviderです。schema-v4 serverは`issue-task` capabilityとしてdraft codec、検証、workflow出力取込、provider呼出、annotation単位single-flightを提供します。結果不明の外部side effectは自動retryしません。

## Installation

認証済みの`gh`が利用できることを確認し、対象workspaceでinstallします。

```sh
visual-review plugin install @nakak10/visual-review-plugin-github-issue
```

source checkoutから試す場合:

```sh
visual-review plugin install ./plugins/github-issue
```

pluginのinstallはmanifestとfileを検証・copyするだけで、module codeを実行しません。provider codeが読み込まれるのはIssue作成時です。

## Behavior and safety

providerはshellを介さず、対象repositoryをworking directoryとして次を実行します。

```text
gh issue create --title <title> --body-file -
```

Issue bodyはcommand line argumentではなく標準入力へ渡します。実行は30秒でtimeoutし、標準出力と標準エラーの合計を64 KiBに制限します。成功時は`https://github.com/<owner>/<repo>/issues/<number>`形式のURLだけを受理します。
