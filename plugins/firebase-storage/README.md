# Firebase Storage plugin for Visual Review

Firestore REST を使い、Visual Review workspace の共有可能な JSON を 1 document に同期する、依存 package なしの sample plugin です。Node.js 20 の組み込み `fetch` のみを使います。

> この版が明示的に対応する認証は **OAuth 2 access token (`FIREBASE_ACCESS_TOKEN`) のみ**です。service account key、Application Default Credentials、`GOOGLE_APPLICATION_CREDENTIALS` の読み込みや token refresh は行いません。

## 導入

repository の `plugins/` 全体ではなく、**一段ネストしたこの directory**を指定します。

```sh
# 公開package
visual-review plugin install @nakak10/visual-review-firebase-storage

# source checkout
visual-review plugin install ./plugins/firebase-storage
```

Firebase project で Firestore database を作成し、利用者が対象 document を read/write できる OAuth access token を安全な手段で取得して、実行 process の環境変数へ渡します。token や service account JSON は repository、plugin 設定、`.vreview` に保存しないでください。

```sh
export FIREBASE_PROJECT_ID='your-project-id'
export FIREBASE_ACCESS_TOKEN="$(gcloud auth print-access-token)" # 例。plugin 自体は gcloud を呼びません
export FIREBASE_COLLECTION_ID='visual-review-workspaces'          # optional
export FIREBASE_DOCUMENT_ID='team-workspace'                      # optional
export FIREBASE_DATABASE_ID='(default)'                           # optional
```

`FIREBASE_PROJECT_ID` は常に必須です。network access を伴う操作には `FIREBASE_ACCESS_TOKEN` も必須です。既定 collection は `visual-review-workspaces`、document は `default`、database は `(default)` です。複数 workspace を扱う場合は衝突を避けるため document ID を明示してください。ID は 1〜128 文字の英数字、`.`、`_`、`-` に制限しています（database の `(default)` のみ例外）。

## Commands

manifest は `push`、`pull`、`status` の command export を公開します。Visual Review CLIから実行できます。

```sh
visual-review plugin run firebase-storage push --dry-run
visual-review plugin run firebase-storage status --document team-workspace
visual-review plugin run firebase-storage pull --document team-workspace
```

plugin runtime APIから直接呼ぶこともできます。

```js
import { loadPluginCommand } from "@nakak10/visual-review";

const workspaceRoot = process.cwd();
const { handler } = await loadPluginCommand("firebase-storage", "push", workspaceRoot);
await handler({
  workspaceRoot,
  pluginDirectory: `${workspaceRoot}/.vreview/plugins/firebase-storage`,
  args: ["--document", "team-workspace", "--dry-run"],
});
```

全 command で次を指定できます。

- `--collection ID` / `--collection=ID`
- `--document ID` / `--document=ID`
- `--database ID` / `--database=ID`
- `--dry-run`: `push` は network write をせず local snapshot のみ検証、`pull` は remote を取得・検証するが local write はしない。`status` では使用不可。

### 同期対象

- `.vreview/settings.json`（存在する場合）
- `.vreview/reviews/` 配下の通常 JSON file

次は送受信しません。remote payload に含まれていた場合も pull 前に拒否します。

- `job-state.json`
- `.server-lease.json`、`.transaction.json`、`*.lock`
- path segment が `secret(s)`、`credential(s)`、`token(s)` で始まる JSON
- symlink、JSON 以外、`.vreview/settings.json` と `.vreview/reviews/` の外側

`push` は最初に remote document を取得し、既存 document には取得した `updateTime`、未作成 document には `currentDocument.exists=false` の precondition を付けて、同期対象全体の snapshot で置換します。読み取り後に他の client が更新・作成した場合は HTTP 412 を競合として明示的に報告し、無条件には上書きしません。

`pull` は remote に含まれる file を上書きしますが、remote にない local file は削除しません。部分適用を避けるため、全 JSON を workspace 内の安全な staging directory に書き出して再検証してから destination へ commit します。commit 中に失敗した場合、既存 file は staging 内の backup から rollback します。rollback 自体が完了できない場合は復旧用 backup の場所を error に示して保持します。symlink は staging 前と commit 直前に拒否します。

payload は schema、path、JSON 型、重複、sort 順、digest、file 数・size に加え、`a.json` と `a.json/b.json` のような file/directory prefix conflict を検証します。Firestore の document size 上限に余裕を持たせ、snapshot を 850 KiB に制限しています。

`status` は file ごとに `local-only`、`remote-only`、`modified` を表示します。差分がなければ `Up to date` を表示します。

## Storage provider API

manifestはbackend-neutralな`WorkspaceStorageProviderV1`を公開します。Firestore documentの`updateTime`をopaque `version`として扱い、local・MySQL・PostgreSQL providerと同じcompare-and-swap契約へ揃えています。

```js
const { provider } = await loadWorkspaceStorageProviderV1("firebase-storage", workspaceRoot);
const key = ".vreview/reviews/page/review.json";
const current = await provider.read(key);
const written = await provider.compareAndSwap(
  key,
  current?.version ?? null,
  jsonValue,
);
await provider.delete(key, written.version);
```

- `list(prefix) -> Promise<string[]>`
- `read(key) -> Promise<{ version, value } | null>`
- `compareAndSwap(key, expectedVersion, value) -> Promise<{ version }>`
- `delete(key, expectedVersion) -> Promise<void>`

stale versionは`StorageConflictError`として失敗し、無条件上書きしません。plugin生成時に`projectId`、`accessToken`、`collectionId`、`documentId`、`databaseId`を固定したい場合は`createWorkspaceStorageProvider(options)`を使えます。

従来の`storageProvider`（`list/read/write`）もcommand内部・移行互換用にexportしますが、manifestからは公開しません。`pull`は現時点では明示的なlegacy同期操作であり、running serverのauthoritative storageを差し替える用途には使わないでください。

## Security / operations

- access token は Firestore の必要な document だけを操作できる最小権限・短寿命のものを使用してください。
- この sample は token を log、file、Firestore payload に保存しません。
- Firestore Security Rules / IAM、backup、retention、token refresh は運用側の責任です。
- document URL は固定の Google Firestore endpoint だけを使用します。

## Test

外部接続や credential は不要です。mock `fetch` と temporary workspace で自己完結します。

```sh
cd plugins/firebase-storage
npm test
```
