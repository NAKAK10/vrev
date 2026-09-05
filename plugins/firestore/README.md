# Firestore plugin for Vrev

Firestore REST を使い、Vrev workspace の共有可能な JSON を storage key ごとに 1 Firestore document として同期する、依存 package なしの plugin です。Node.js 20 の組み込み `fetch` のみを使います。

1 workspace 分の file をまとめて 1 document へ JSON snapshot として詰め込む方式とは異なり、この plugin は Core の `WorkspaceStorageProviderV1` 契約（[`docs/storage-providers.md`](../../docs/storage-providers.md)）が要求する **storage key ごとの独立した document** をそのまま実装します。1 document = 1 key なので、key 単位の compare-and-swap・削除・prefix listing がすべて Firestore の document 単位 precondition に自然に対応します。

## データモデル

- storage key（例 `reviews/home/review.json`、canonical relative POSIX path）は決定的かつ可逆な方式で Firestore document ID へ変換します。`k` + `base64url(key)` という形式で、`k` から始まるため Firestore の予約 ID（`.`、`..`、`/^__.*__$/`）に絶対に一致しません。往復（encode → decode）は `plugins/firestore/test.mjs` で検証しています。
- 各 document の fields は次のとおりです。

  | field | 型 | 内容 |
  |---|---|---|
  | `schemaVersion` | `integerValue` | document schema の version（現在 `1`） |
  | `key` | `stringValue` | 元の storage key（document ID との整合性検証に使用） |
  | `payload` | `stringValue` | 値を key でsortした決定的な JSON文字列 |
  | `digest` | `stringValue` | `payload` の SHA-256 hex |
  | `updatedAt` | `timestampValue` | 書き込み時刻（ISO 8601） |

- `version`（`WorkspaceStorageProviderV1` の opaque version）には Firestore document の `updateTime` をそのまま使います。
- 1 document あたりの payload は Firestore の 1 MiB 制限に対して安全側の 850 KiB を上限とし、超過分はネットワークへ送る前に reject します。読み込み側でも同じ上限、`schemaVersion`、`digest` 一致を検証してから値を返します。壊れた/大きすぎる document は review ロジックへ渡る前に例外になります。

## 認証方式

設定画面（`/settings/plugins`）の「認証方式」（`auth_mode`）で 4 通りから選べます。いずれも token 取得は `auth.mjs` が担い、`push`/`pull`/`status` や storage provider から共通で使われます。

| `auth_mode` | 概要 | 必要な設定 |
|---|---|---|
| `access_token`（既定） | 環境変数の OAuth access token をそのまま使う。plugin 自体は token を発行しません。 | 環境変数 `FIREBASE_ACCESS_TOKEN` |
| `service_account` | サービスアカウント key の `private_key` で RS256 JWT を自己署名し、`https://oauth2.googleapis.com/token` へ交換します（scope `https://www.googleapis.com/auth/datastore`）。 | credential `service_account_key`（JSON） |
| `gcloud` | `gcloud auth print-access-token` を child process として起動します（`--account` は `gcloud_account` を指定した場合のみ付与）。 | ローカルの gcloud CLI、任意で workspace 設定 `gcloud_account` |
| `firebase_web` | `firebaseConfig` の `apiKey` で Firebase Auth の匿名ログイン（`accounts:signUp`）を行い、以降は `securetoken.googleapis.com` で refresh token を使い延長します。 | credential `firebase_web_config`（JSON） |

取得した token は有効期限の 60 秒前まで（`gcloud` は 50 分固定）plugin 内でcacheし、Firestore が 401 を返した場合は 1 回だけ強制refreshして再試行します（無限retryはしません）。

`service_account`/`firebase_web` の credential は **設定画面からのみ**登録します。値は `.vrev/credentials/firestore.json`（directory mode `0700`、file mode `0600`、`.vrev/.gitignore` へ自動追記）へ保存され、Git管理外です。画面・API へ値そのものが返ることはなく、登録済みかどうか（`present`）・更新日時・先頭8文字のfingerprintだけを表示します。repository、`.vrev/plugin-settings.json`、log、command引数のいずれにも値を書き込みません。token・key・firebaseConfigの値はURL・log・例外メッセージ・subprocessのargvにも一切現れません。

`firebase_web` を使う場合、Firestore Security Rules は匿名principal（`request.auth != null` など）に対象collectionへのread/write権限を許可している必要があります。匿名ユーザーは長期的なaccount所有者ではないため、rulesの設計と運用側の責任で範囲を絞ってください。

## 導入

repository の `plugins/` 全体ではなく、**一段ネストしたこの directory**を指定します。

```sh
# 公開package
npm install --save-dev @vrev/storage-firestore

# source checkout
vrev plugin install ./plugins/firestore
```

Firebase project で Firestore database を作成し、選んだ認証方式で対象 collection を read/write できる権限を用意してください。

```sh
# access_token の例
export FIREBASE_ACCESS_TOKEN="$(gcloud auth print-access-token)"
export FIREBASE_PROJECT_ID='sample-project'                       # optional（project_idやcredentialから補完できない場合は必須）
export FIREBASE_COLLECTION_ID='vrev-storage'              # optional
export FIREBASE_DATABASE_ID='(default)'                            # optional
```

project ID は明示した `project_id`（設定画面のworkspace設定）を最優先し、未設定なら環境変数 `FIREBASE_PROJECT_ID`、次に `service_account_key` の `project_id`、次に `firebase_web_config` の `projectId` の順で補完します。いずれも解決できない場合はエラーになります。既定 collection は `vrev-storage`、database は `(default)` です。ID は 1〜128 文字の英数字、`.`、`_`、`-` に制限しています（database の `(default)` のみ例外）。

## 有効化・無効化の挙動

この plugin を **設定画面（`/settings/plugins`）で有効化**し、required な設定（`auth_mode` に応じた credential・環境変数）が揃うと、以後の review の読み書き先はこの Firestore がすべて（authoritative）になります。ローカル `.vrev/reviews/**` への読み書きは行われません。**無効化**すると、サーバーを再起動しなくても次のアクセスからローカル file system へ戻ります。

有効化・無効化そのものは既存データを **一切コピーしません**。たとえば Firestore を無効化して local へ戻すと、local に該当 review が存在しなければ新しい空の review から始まります。Firestore 側のデータはそのまま残ります。既存データを新しい backend へ移す・戻すには、設定画面の「データの上書き」（Storage transfer）から明示的に実行してください。API としては `POST /api/settings/plugins/firestore/storage-transfer`（body `{ "direction": "local-to-plugin" | "plugin-to-local", "dry_run": boolean }`）です。

同時に有効化できる storage provider plugin は 1 つまでです。他の storage provider plugin と同時に有効化すると、review の読み書きは（このplugin側もローカル側も含めて）fail closed でエラーになります。

## Commands

manifest は `push`、`pull`、`status` の command export を公開します。Vrev CLIから実行できます。

```sh
vrev plugin run firestore push --dry-run
vrev plugin run firestore status
vrev plugin run firestore pull --collection team-storage
```

plugin runtime APIから直接呼ぶこともできます。

```js
import { loadPluginCommand } from "@vrev/cli";

const workspaceRoot = process.cwd();
const { handler } = await loadPluginCommand("firestore", "push", workspaceRoot);
await handler({
  workspaceRoot,
  pluginDirectory: `${workspaceRoot}/.vrev/plugins/firestore`,
  args: ["--collection", "team-storage", "--dry-run"],
});
```

全 command で次を指定できます。

- `--collection ID` / `--collection=ID`
- `--database ID` / `--database=ID`
- `--dry-run`: `push` は network へ一切アクセスせず local の対象file数のみ検証・表示します。`pull` は remote documentの取得は行いますが（内容を確認するため）、local file への書き込みは行いません。`status` では使用不可。

同期先を1 documentへ固定する `--document` option はありません。document は key ごとに自動的に決まるためです。

### 同期対象とローカルパス⇔storage keyの対応

storage key は local path から `.vrev/` prefixを外しただけの、決定的かつ可逆な対応です（`localPathToStorageKey` / `storageKeyToLocalPath`、`index.mjs`内の1箇所で定義）。

| local path | storage key |
|---|---|
| `.vrev/settings.json` | `settings.json` |
| `.vrev/reviews/home/review.json` | `reviews/home/review.json` |

同期対象は次のみです。

- `.vrev/settings.json`（存在する場合）
- `.vrev/reviews/` 配下の通常 JSON file

次は送受信しません。remote に存在していた場合も pull 前に無視します（自プラグインが書いた document ID としてもdecodeされません）。

- `job-state.json`
- `.server-lease.json`、`.transaction.json`、`*.lock`
- path segment が `secret(s)`、`credential(s)`、`token(s)` で始まる JSON
- symlink、JSON 以外、`.vrev/settings.json` と `.vrev/reviews/` の外側

`push` は対象 file ごとに、まず対応する document を読み込んで現在の `updateTime`（未作成なら `null`）を取得し、それを precondition として compare-and-swap で書き込みます。読み取り後に他の client が該当 document を更新・作成した場合は `StorageConflictError` を投げ、無条件には上書きしません。

`pull` は remote に存在する document をすべて取得し、対応する local file へ上書きします。remote にない local file は削除しません。部分適用を避けるため、全 JSON を workspace 内の安全な staging directory に書き出して再検証してから destination へ commit します。commit 中に失敗した場合、既存 file は staging 内の backup から rollback します。rollback 自体が完了できない場合は復旧用 backup の場所を error に示して保持します。symlink は staging 前と commit 直前に拒否します。

`status` は key ごとに `local-only`、`remote-only`、`modified` を表示します。差分がなければ `Up to date` を表示します。

## Storage provider API (`WorkspaceStorageProviderV1`)

manifestはbackend-neutralな`WorkspaceStorageProviderV1`を公開します。Firestore documentの`updateTime`をopaque `version`として扱い、local・MySQL・PostgreSQL providerと同じcompare-and-swap契約へ揃えています。

```js
const { provider } = await loadPluginStorageProvider("firestore", workspaceRoot);
const key = "reviews/home/review.json";
const current = await provider.read(key);
const written = await provider.compareAndSwap(
  key,
  current?.version ?? null,
  jsonValue,
);
await provider.delete(key, written.version);
```

- `list(prefix) -> Promise<string[]>`: collectionを`documents:list` API（`pageSize`/`pageToken`によるページング対応）で列挙し、`prefix`一致するstorage keyを決定的にソートして返します。
- `read(key) -> Promise<{ version, value } | null>`: documentが存在しなければ`null`。`schemaVersion`・`digest`・sizeを検証してから値を返します。
- `compareAndSwap(key, expectedVersion, value) -> Promise<{ version }>`: `expectedVersion === null`は`currentDocument.exists=false`によるcreate-onlyです。412 conflictは`StorageConflictError`になります。
- `delete(key, expectedVersion) -> Promise<void>`: `currentDocument.updateTime`によるprecondition付き削除です。412/404は`StorageConflictError`になります。

stale versionや存在しないdocumentへの操作は`error.name === "StorageConflictError"`を満たすerrorとして失敗し、無条件上書きしません。plugin生成時に`projectId`、`accessToken`、`collectionId`、`databaseId`を固定したい場合は`createWorkspaceStorageProvider(options)`を使えます。

manifestの`storage_provider.export`は`createWorkspaceStorageProviderFromContext`（factory function）です。Vrev本体のloaderは有効化済みplugin向けにこのfunctionを一度だけ`PluginRuntimeContextV1`（`workspaceRoot`、`pluginDirectory`、`configuration`、`credentials`、`env`）付きで呼び出し、戻り値の`WorkspaceStorageProviderV1`を使います。

## Security / operations

- どの認証方式でも、対象 collection だけを操作できる最小権限のprincipalを使用してください。
- この plugin は token・service account key・firebaseConfig を log、review JSON、Firestore payload、`.vrev/plugin-settings.json`、command引数に一切保存しません。secretは`.vrev/credentials/firestore.json`（file mode `0600`）にのみ保存され、Coreの設定APIは登録済みかどうか・更新日時・fingerprintしか返しません。
- Firestore Security Rules / IAM、backup、retention、token/refresh tokenの失効は運用側の責任です。`firebase_web`利用時は匿名principalへ許可するrulesの範囲に特に注意してください。
- document URL は固定の Google Firestore endpoint だけを使用します。

## 開発

外部接続や実際の credential は不要です。mock `fetch`・mock `spawn`・temporary workspaceで自己完結する in-memory Firestore stand-inをtest内に実装しています。`service_account`のJWT署名は使い捨てのRSA鍵ペア（`node:crypto`の`generateKeyPairSync`）をtest内で生成して検証し、鍵material自体はrepositoryに含みません。

```sh
cd plugins/firestore
npm test
```
