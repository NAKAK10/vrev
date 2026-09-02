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

## Issue draft dialogのrepo/account表示

Issue draft dialogは、タイトル欄の上に小さく薄い文字で

```text
repo: <owner>/<repo>
account: <login>
```

を表示します。これは`gh repo view`と`gh api user`を対象repositoryのworking directoryで実行して得た値で、サーバプロセスが実際に引き継いでいる`gh`の認証・remote設定を反映します。ここに表示されるrepositoryとaccountが意図したものと違う場合、「GitHubにIssueを追加」を押しても`Could not resolve to a Repository`のようなエラーで作成に失敗するので、送信前にこの表示で気づけます。取得に失敗した場合（`gh`未認証、remoteなし、timeoutなど）はその行ごと表示されません。

## Annotation card status badges

`issue-task` capabilityは`label(annotation)`を通じてannotation cardのstatus badgeを供給します。Issue依頼のflowに沿って「Issueラフ作成中」→「AI Issueラフ作成中」→「Issueラフ確認待ち」→「Issue作成済み」と遷移し、ラフ生成に失敗した場合は「Issueラフ作成失敗」を表示します。これらのbadgeはgithub-issue pluginがannotation-workflow pluginへ提供するもので、本pluginを無効化するとcardはworkflow側のdefault labelに戻ります。

同じcapabilityの`filters()`/`filter(annotation)`により、注釈一覧の絞り込みチップにも同じ5つのlabelが追加されます。badgeとchipは単一のcategory表から導出するため常に1対1で一致し、Issue依頼した注釈は「未対応」チップではなく対応するchipで絞り込まれます。
