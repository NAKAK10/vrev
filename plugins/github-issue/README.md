# Visual Review GitHub Issue plugin

レビュー対象のノードまたは範囲を選び、AIで独立したGitHub Issue案を生成し、人間が編集・確認してから GitHub CLI (`gh`) でIssueを作成するpluginです。headerのセグメント化された「Issueノード」「Issue範囲」、2段階の専用dialog、作成済みIssueのsidebar一覧をこのpackageが所有します。

## Installation

認証済みの`gh`と、`text-only` modeに対応するAI連携が利用できることを確認し、対象workspaceでinstallします。

```sh
npm install --save-dev @visual-review/github-issue
```

source checkoutから試す場合:

```sh
visual-review plugin install ./plugins/github-issue
```

本pluginは`review/v1`と`ai/v1`だけを利用し、CLI、外部コマンド、ほかのworkflow pluginには直接依存しません。利用するAIはAI packageのworkspace設定が解決するため、本pluginはAI選択UIを持ちません。

## Usage

1. headerの「Issueノード」または「Issue範囲」を選びます。
2. ページ上の対象をクリック、または範囲をドラッグします。
3. repository/accountを確認し、簡潔な依頼を1つ入力します。
4. AI packageのworkspace設定で選択済みのAIが生成したタイトルと本文を編集・確認します。この段階では保存もGitHubへの送信も行われません。
5. 「GitHubにIssueを作成」を明示的に押します。作成済みIssueはsidebarから開けます。

## Behavior and safety

AI draftはnonce付きmarker間の、厳密に`title`と`body`だけを持つJSON objectとして受理します。内部review参照を拒否し、出力を128 KiBに制限します。生成はsingle-flightで、120秒後にprocess treeをcancelします。`ai/v1`が公開する`text-only` mode対応のAIだけを利用し、draft生成ではreviewへの永続化やGitHub Issue作成を行いません。表示先の確認に限り、read-onlyな`gh repo view` / `gh api user`を利用します。対象ページのscriptを有効にした場合は、CoreのAI実行許可が明示されていなければdraft生成・作成を無効にします。

Issue作成providerはshellを介さず、対象repositoryをworking directoryとして次を実行します。

```text
gh issue create --title <title> --body-file -
```

Issue bodyは標準入力へ渡します。実行は30秒でtimeoutし、出力を64 KiBに制限します。成功時は`https://github.com/<owner>/<repo>/issues/<number>`形式のURLだけを受理し、結果が不明な外部side effectは自動retryしません。

入力dialogには`gh repo view`と`gh api user`によるrepositoryとaccountを常に表示し、取得できない場合は「利用できません」と明示します。
