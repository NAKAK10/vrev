# Firebase Storage plugin for Visual Review

Firestore REST を使い、Visual Review workspace の共有可能な JSON を 1 document に同期する、依存 package なしの sample plugin です。Node.js 20 の組み込み `fetch` のみを使います。

## 認証方式

設定画面（`/settings/plugins`）の「認証方式」（`auth_mode`）で 4 通りから選べます。いずれも token 取得は `auth.mjs` が担い、`push`/`pull`/`status` や storage provider から共通で使われます。

| `auth_mode` | 概要 | 必要な設定 |
|---|---|---|
| `access_token`（既定） | 環境変数の OAuth access token をそのまま使う。plugin 自体は token を発行しません。 | 環境変数 `FIREBASE_ACCESS_TOKEN` |
| `service_account` | サービスアカウント key の `private_key` で RS256 JWT を自己署名し、`https://oauth2.googleapis.com/token` へ交換します（scope `https://www.googleapis.com/auth/datastore`）。 | credential `service_account_key`（JSON） |
| `gcloud` | `gcloud auth print-access-token` を child process として起動します（`--account` は `gcloud_account` を指定した場合のみ付与）。 | ローカルの gcloud CLI、任意で workspace 設定 `gcloud_account` |
| `firebase_web` | `firebaseConfig` の `apiKey` で Firebase Auth の匿名ログイン（`accounts:signUp`）を行い、以降は `securetoken.googleapis.com` で refresh token を使い延長します。 | credential `firebase_web_config`（JSON） |

取得した token は有効期限の 60 秒前まで（`gcloud` は 50 分固定）plugin 内でcacheし、Firestore が 401 を返した場合は 1 回だけ強制refreshして再試行します。

`service_account`/`firebase_web` の credential は **設定画面からのみ**登録します。値は `.vreview/credentials/firebase-storage.json`（directory mode `0700`、file mode `0600`、`.vreview/.gitignore` へ自動追記）へ保存され、Git管理外です。画面・API へ値そのものが返ることはなく、登録済みかどうか（`present`）・更新日時・先頭8文字のfingerprintだけを表示します。repository、`.vreview/plugin-settings.json`、log、command引数のいずれにも値を書き込みません。

`firebase_web` を使う場合、Firestore Security Rules は匿名principal（`request.auth != null` など）に対象documentへのread/write権限を許可している必要があります。匿名ユーザーは長期的なaccount所有者ではないため、rulesの設計と運用側の責任で範囲を絞ってください。

## 導入

repository の `plugins/` 全体ではなく、**一段ネストしたこの directory**を指定します。

```sh
# 公開package
visual-review plugin install @nakak10/visual-review-firebase-storage

# source checkout
visual-review plugin install ./plugins/firebase-storage
```

Firebase project で Firestore database を作成し、選んだ認証方式で対象 document を read/write できる権限を用意してください。

```sh
# access_token の例
export FIREBASE_ACCESS_TOKEN="$(gcloud auth print-access-token)"
export FIREBASE_COLLECTION_ID='visual-review-workspaces'          # optional
export FIREBASE_DOCUMENT_ID='team-workspace'                      # optional
export FIREBASE_DATABASE_ID='(default)'                           # optional
```

project ID は明示した `project_id`（設定画面のworkspace設定）を最優先し、未設定なら環境変数 `FIREBASE_PROJECT_ID`、次に `service_account_key` の `project_id`、次に `firebase_web_config` の `projectId` の順で補完します。いずれも解決できない場合はエラーになります。既定 collection は `visual-review-workspaces`、document は `default`、database は `(default)` です。複数 workspace を扱う場合は衝突を避けるため document ID を明示してください。ID は 1〜128 文字の英数字、`.`、`_`、`-` に制限しています（database の `(default)` のみ例外）。

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

manifestの`storage_provider.export`は`createWorkspaceStorageProviderFromContext`（factory function）です。Visual Review本体のloaderは有効化済みplugin向けにこのfunctionを一度だけ`PluginRuntimeContextV1`（`workspaceRoot`、`pluginDirectory`、`configuration`、`credentials`、`env`）付きで呼び出し、戻り値の`WorkspaceStorageProviderV1`を使います。従来どおり環境変数のみで動く`workspaceStorageProvider`（`export const`のobject）も後方互換のため残していますが、新規installはmanifest経由のfactory export側が使われます。

従来の`storageProvider`（`list/read/write`）もcommand内部・移行互換用にexportしますが、manifestからは公開しません。`pull`は現時点では明示的なlegacy同期操作であり、running serverのauthoritative storageを差し替える用途には使わないでください。

## Security / operations

- どの認証方式でも、Firestore の必要な document だけを操作できる最小権限のprincipalを使用してください。
- この plugin は token・service account key・firebaseConfig を log、review JSON、Firestore payload、`.vreview/plugin-settings.json`、command引数に一切保存しません。secretは`.vreview/credentials/firebase-storage.json`（file mode `0600`）にのみ保存され、Coreの設定APIは登録済みかどうか・更新日時・fingerprintしか返しません。
- Firestore Security Rules / IAM、backup、retention、token/refresh tokenの失効は運用側の責任です。`firebase_web`利用時は匿名principalへ許可するrulesの範囲に特に注意してください。
- document URL は固定の Google Firestore endpoint だけを使用します。

## Test

外部接続や実際の credential は不要です。mock `fetch`・mock `spawn`・temporary workspace で自己完結します。`service_account`のJWT署名は使い捨てのRSA鍵ペア（`node:crypto`の`generateKeyPairSync`）をtest内で生成して検証し、鍵material自体はrepositoryに含みません。

```sh
cd plugins/firebase-storage
npm test
```
