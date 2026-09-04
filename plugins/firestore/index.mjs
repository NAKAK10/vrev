// Firestore storage plugin for Visual Review. Unlike the legacy Firebase Storage plugin, this
// plugin keeps one Firestore document per storage key instead of packing every file into a
// single snapshot document. A storage key such as `reviews/home/review.json` is deterministically
// and reversibly encoded into a Firestore document ID (see `encodeStorageKeyToDocumentId` /
// `decodeStorageKeyFromDocumentId`), and each document's `updateTime` is used, unmodified, as the
// opaque `version` required by `WorkspaceStorageProviderV1`.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createTokenSource } from "./auth.mjs";

const DOCUMENT_SCHEMA_VERSION = 1;
const DEFAULT_COLLECTION_ID = "visual-review-storage";
const DEFAULT_DATABASE_ID = "(default)";
const MAX_PAYLOAD_BYTES = 850 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const MAX_STORAGE_KEY_BYTES = 900;
const MAX_DOCUMENT_ID_BYTES = 1500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUNTIME_NAMES = new Set(["job-state.json", ".server-lease.json", ".transaction.json"]);
const SECRET_SEGMENT = /^(?:secret|secrets|credential|credentials|token|tokens)(?:[._-].*)?$/i;
const LOCAL_SYNC_PREFIX = ".vreview/";
// Every encoded document ID starts with this letter, which guarantees it can never equal "."
// or "..", never starts with "_" (so it can never match Firestore's reserved `/^__.*__$/`
// pattern), and never collides with a plain ASCII collection listing of unrelated documents.
const DOCUMENT_ID_PREFIX = "k";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

/** Deterministic (key-sorted) JSON encoding used both for the stored payload and its digest. */
function stableStringify(value) {
  const encoded = JSON.stringify(sortedValue(value));
  if (encoded === undefined) throw new Error("value is not JSON-serializable");
  return encoded;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validateId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value === "." || value === ".." || /^__.*__$/.test(value)) {
    throw new Error(`${label} must be 1-128 letters, numbers, dots, underscores, or hyphens and must not be reserved`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Storage key <-> Firestore document ID
// ---------------------------------------------------------------------------------------------

/** A storage key is a canonical, non-empty, relative POSIX path (see `src/storage-provider.ts`). */
export function validateStorageKey(key) {
  if (typeof key !== "string" || key === "") throw new Error("storage key must be a non-empty string");
  if (key.includes("\\") || key.startsWith("/") || key.endsWith("/")) throw new Error(`storage key must be a canonical relative POSIX path: ${key}`);
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`storage key must be a canonical relative POSIX path: ${key}`);
  if (Buffer.byteLength(key, "utf8") > MAX_STORAGE_KEY_BYTES) throw new Error(`storage key exceeds ${MAX_STORAGE_KEY_BYTES} bytes: ${key}`);
  return key;
}

/** Encodes a storage key into a valid, reversible Firestore document ID. */
export function encodeStorageKeyToDocumentId(key) {
  validateStorageKey(key);
  const documentId = `${DOCUMENT_ID_PREFIX}${Buffer.from(key, "utf8").toString("base64url")}`;
  if (Buffer.byteLength(documentId, "utf8") > MAX_DOCUMENT_ID_BYTES) throw new Error(`storage key is too long to encode as a Firestore document ID: ${key}`);
  return documentId;
}

/** Inverse of `encodeStorageKeyToDocumentId`. Throws if `documentId` was not produced by it. */
export function decodeStorageKeyFromDocumentId(documentId) {
  if (typeof documentId !== "string" || !documentId.startsWith(DOCUMENT_ID_PREFIX)) throw new Error(`not a Visual Review storage document ID: ${documentId}`);
  const key = Buffer.from(documentId.slice(DOCUMENT_ID_PREFIX.length), "base64url").toString("utf8");
  if (encodeStorageKeyToDocumentId(key) !== documentId) throw new Error(`not a Visual Review storage document ID: ${documentId}`);
  return key;
}

/** Non-throwing variant used while scanning a collection that may contain unrelated documents. */
function tryDecodeStorageKeyFromDocumentId(documentId) {
  try {
    return decodeStorageKeyFromDocumentId(documentId);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Local file <-> storage key mapping (defined exactly once)
// ---------------------------------------------------------------------------------------------

/** `.vreview/reviews/home/review.json` -> `reviews/home/review.json`. */
export function localPathToStorageKey(relativePath) {
  if (!relativePath.startsWith(LOCAL_SYNC_PREFIX)) throw new Error(`local path is outside the synchronized ${LOCAL_SYNC_PREFIX} directory: ${relativePath}`);
  return validateStorageKey(relativePath.slice(LOCAL_SYNC_PREFIX.length));
}

/** Inverse of `localPathToStorageKey`. */
export function storageKeyToLocalPath(key) {
  return `${LOCAL_SYNC_PREFIX}${validateStorageKey(key)}`;
}

// ---------------------------------------------------------------------------------------------
// Local filesystem access (settings + review JSON only, symlink/traversal-safe)
// ---------------------------------------------------------------------------------------------

function normalizeWorkspaceRoot(workspaceRoot = process.cwd()) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new Error("workspaceRoot must be a non-empty string");
  return path.resolve(workspaceRoot);
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw new Error("file path must be a relative POSIX path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("file path contains path traversal");
  if (relativePath !== ".vreview/settings.json" && !(segments[0] === ".vreview" && segments[1] === "reviews" && segments.length >= 4)) {
    throw new Error(`file path is outside the supported Visual Review data: ${relativePath}`);
  }
  const basename = segments.at(-1).toLowerCase();
  if (!basename.endsWith(".json")) throw new Error(`only JSON files can be synchronized: ${relativePath}`);
  if (RUNTIME_NAMES.has(basename) || basename.endsWith(".lock") || segments.some((segment) => SECRET_SEGMENT.test(segment))) {
    throw new Error(`secret or runtime file is excluded from synchronization: ${relativePath}`);
  }
  return relativePath;
}

function safeLocalPath(workspaceRoot, relativePath, forWrite = false) {
  validateRelativePath(relativePath);
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("file path escapes the workspace");

  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`symbolic links are not allowed in synchronized paths: ${relativePath}`);
    if (existsSync(current) && !lstatSync(current).isDirectory()) throw new Error(`path component is not a directory: ${relativePath}`);
    if (!existsSync(current) && !forWrite) break;
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`synchronized path must be a regular file: ${relativePath}`);
  }
  return target;
}

function parseLocalJsonFile(workspaceRoot, relativePath) {
  const filePath = safeLocalPath(workspaceRoot, relativePath);
  const stat = lstatSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`JSON file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoverReviewJsonPaths(workspaceRoot) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const reviewsRoot = path.join(root, ".vreview", "reviews");
  if (!existsSync(reviewsRoot)) return [];
  if (lstatSync(reviewsRoot).isSymbolicLink() || !lstatSync(reviewsRoot).isDirectory()) throw new Error(".vreview/reviews must be a regular directory");
  const result = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in synchronized paths: ${relativePath}`);
      if (entry.isDirectory()) {
        if (!SECRET_SEGMENT.test(entry.name)) visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json") && !RUNTIME_NAMES.has(entry.name.toLowerCase()) && !entry.name.toLowerCase().endsWith(".lock") && !SECRET_SEGMENT.test(entry.name)) {
        validateRelativePath(relativePath);
        result.push(relativePath);
      }
    }
  };
  visit(reviewsRoot, ".vreview/reviews");
  return result;
}

/** Every locally synchronizable file as `{ path, key, value }`, sorted by key. */
export function collectLocalFiles(workspaceRoot = process.cwd()) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const relativePaths = [];
  if (existsSync(path.join(root, ".vreview", "settings.json"))) relativePaths.push(".vreview/settings.json");
  relativePaths.push(...discoverReviewJsonPaths(root));
  if (relativePaths.length > MAX_FILES) throw new Error(`workspace contains more than ${MAX_FILES} synchronizable files`);
  return [...new Set(relativePaths)]
    .map((relativePath) => ({ path: relativePath, key: localPathToStorageKey(relativePath), value: parseLocalJsonFile(root, relativePath) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function atomicWriteJsonFile(workspaceRoot, relativePath, value) {
  const target = safeLocalPath(workspaceRoot, relativePath, true);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Re-check after mkdir so a concurrently inserted symlink cannot redirect the final write.
  safeLocalPath(workspaceRoot, relativePath, true);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${relativePath}`);
    renameSync(temporary, target);
    try {
      const directory = openSync(path.dirname(target), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Atomically writes every `{ path, value }` entry to the workspace, or none at all. Destinations
 * are all validated before any file is touched; on a mid-commit failure, files already replaced
 * are rolled back from a staging backup.
 */
export function applyRemoteFiles(files, workspaceRoot = process.cwd(), { dryRun = false } = {}) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  for (const file of files) safeLocalPath(root, file.path, true);
  if (dryRun || files.length === 0) return files.map((file) => file.path);

  const stageRoot = path.join(root, `.firestore-stage-${process.pid}-${randomUUID()}`);
  const stagedFilesRoot = path.join(stageRoot, "files");
  const backupRoot = path.join(stageRoot, "backup");
  mkdirSync(stagedFilesRoot, { recursive: true, mode: 0o700 });
  let preserveStage = false;
  try {
    // Materialize and re-parse every file before touching any destination.
    for (const file of files) atomicWriteJsonFile(stagedFilesRoot, file.path, file.value);
    for (const file of files) {
      const stagedValue = parseLocalJsonFile(stagedFilesRoot, file.path);
      if (stableStringify(stagedValue) !== stableStringify(file.value)) throw new Error(`staged JSON validation failed: ${file.path}`);
    }

    const records = [];
    try {
      for (const file of files) {
        const target = safeLocalPath(root, file.path, true);
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        safeLocalPath(root, file.path, true);
        const staged = safeLocalPath(stagedFilesRoot, file.path);
        const existed = existsSync(target);
        const backup = path.join(backupRoot, ...file.path.split("/"));
        const record = { target, backup, existed, backedUp: false, installed: false, path: file.path };
        records.push(record);
        if (existed) {
          mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
          renameSync(target, backup);
          record.backedUp = true;
        }
        renameSync(staged, target);
        record.installed = true;
      }
    } catch (commitError) {
      const rollbackErrors = [];
      for (const record of records.reverse()) {
        try {
          if (record.installed && existsSync(record.target)) {
            const stat = lstatSync(record.target);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`rollback target is not a regular file: ${record.path}`);
            unlinkSync(record.target);
          }
          if (record.backedUp && existsSync(record.backup)) renameSync(record.backup, record.target);
        } catch (error) {
          rollbackErrors.push(`${record.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        preserveStage = true;
        throw new Error(`commit failed and rollback was incomplete; backups preserved at ${stageRoot}: ${rollbackErrors.join("; ")}`, { cause: commitError });
      }
      throw commitError;
    }
  } finally {
    if (!preserveStage) rmSync(stageRoot, { recursive: true, force: true });
  }
  return files.map((file) => file.path);
}

// ---------------------------------------------------------------------------------------------
// Firestore REST configuration and low-level document field encoding
// ---------------------------------------------------------------------------------------------

async function resolveConfiguration(options = {}, { requireToken = true } = {}) {
  const env = options.env ?? process.env;
  const configFields = isPlainObject(options.configuration) ? options.configuration : {};
  const credentials = isPlainObject(options.credentials) ? options.credentials : {};
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authMode = options.mode ?? (typeof configFields.auth_mode === "string" ? configFields.auth_mode : "access_token");
  const tokenSource = createTokenSource({
    mode: authMode,
    env,
    credentials,
    configuration: configFields,
    fetch: fetchImpl,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const accessToken = options.accessToken ?? (requireToken ? await tokenSource.getAccessToken() : undefined);
  const projectId = options.projectId ?? configFields.project_id ?? env.FIREBASE_PROJECT_ID ?? tokenSource.projectIdHint;
  if (!projectId) throw new Error("Firebase project ID is required (project_id, FIREBASE_PROJECT_ID, or a value in the selected credential)");
  const databaseId = options.databaseId ?? configFields.database_id ?? env.FIREBASE_DATABASE_ID ?? DEFAULT_DATABASE_ID;
  return {
    projectId: validateId(projectId, "Firebase project ID"),
    collectionId: validateId(options.collectionId ?? configFields.collection_id ?? env.FIREBASE_COLLECTION_ID ?? DEFAULT_COLLECTION_ID, "Firestore collection ID"),
    databaseId: databaseId === DEFAULT_DATABASE_ID ? DEFAULT_DATABASE_ID : validateId(databaseId, "Firestore database ID"),
    accessToken,
    fetch: fetchImpl,
    tokenSource,
    listPageSize: options.listPageSize ?? LIST_PAGE_SIZE,
  };
}

function documentsBaseUrl(config) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/${encodeURIComponent(config.databaseId)}/documents`;
}

function collectionUrl(config) {
  return `${documentsBaseUrl(config)}/${encodeURIComponent(config.collectionId)}`;
}

function documentUrl(config, documentId) {
  return `${collectionUrl(config)}/${encodeURIComponent(documentId)}`;
}

/** Issues one Firestore REST request, retrying exactly once (with a forced token refresh) on 401. */
async function firestoreFetch(config, method, url, body) {
  if (typeof config.fetch !== "function") throw new Error("Node.js fetch is unavailable");
  const attempt = async (accessToken) => config.fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response = await attempt(config.accessToken);
  if (response.status === 401 && config.tokenSource) {
    config.accessToken = await config.tokenSource.getAccessToken({ forceRefresh: true });
    response = await attempt(config.accessToken);
  }
  const text = await response.text();
  let parsed;
  if (text) {
    try { parsed = JSON.parse(text); } catch { throw new Error(`Firestore returned a non-JSON response (HTTP ${response.status})`); }
  }
  if (!response.ok) {
    const responseError = isPlainObject(parsed) && isPlainObject(parsed.error) ? parsed.error : null;
    const message = responseError && typeof responseError.message === "string" ? responseError.message : `HTTP ${response.status}`;
    const error = new Error(`Firestore request failed: ${message}`);
    error.status = response.status;
    if (responseError && typeof responseError.status === "string") error.firestoreStatus = responseError.status;
    throw error;
  }
  return parsed;
}

function encodeDocumentFields(key, value) {
  const payload = stableStringify(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`payload for ${key} exceeds the safe Firestore document size limit of ${MAX_PAYLOAD_BYTES} bytes`);
  return {
    fields: {
      schemaVersion: { integerValue: String(DOCUMENT_SCHEMA_VERSION) },
      key: { stringValue: key },
      payload: { stringValue: payload },
      digest: { stringValue: sha256Hex(payload) },
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  };
}

/** Decodes and validates a Firestore document into `{ key, value, updatedAt, version }`. */
function decodeDocumentFields(document, expectedKey) {
  if (!isPlainObject(document) || !isPlainObject(document.fields)) throw new Error("Firestore document has no fields");
  const fields = document.fields;
  requireExactKeys(fields, ["schemaVersion", "key", "payload", "digest", "updatedAt"], "Firestore document fields");
  if (fields.schemaVersion?.integerValue !== String(DOCUMENT_SCHEMA_VERSION)) throw new Error(`Firestore document ${expectedKey} has an unsupported schema`);
  if (
    typeof fields.key?.stringValue !== "string"
    || typeof fields.payload?.stringValue !== "string"
    || typeof fields.digest?.stringValue !== "string"
    || typeof fields.updatedAt?.timestampValue !== "string"
  ) throw new Error(`Firestore document ${expectedKey} fields have invalid types`);
  if (fields.key.stringValue !== expectedKey) throw new Error(`Firestore document key field does not match its document ID: ${expectedKey}`);
  if (Buffer.byteLength(fields.payload.stringValue, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`Firestore payload for ${expectedKey} exceeds the safe size limit`);
  let value;
  try { value = JSON.parse(fields.payload.stringValue); } catch { throw new Error(`Firestore payload for ${expectedKey} is not valid JSON`); }
  if (fields.digest.stringValue !== sha256Hex(fields.payload.stringValue)) throw new Error(`Firestore payload digest for ${expectedKey} does not match its content`);
  if (!Number.isFinite(Date.parse(fields.updatedAt.timestampValue))) throw new Error(`Firestore document ${expectedKey} has an invalid updatedAt`);
  if (typeof document.updateTime !== "string" || !Number.isFinite(Date.parse(document.updateTime))) throw new Error(`Firestore document ${expectedKey} has an invalid updateTime`);
  return { key: expectedKey, value, updatedAt: fields.updatedAt.timestampValue, version: document.updateTime };
}

// ---------------------------------------------------------------------------------------------
// Per-document Firestore operations
// ---------------------------------------------------------------------------------------------

async function getDocument(config, key) {
  const documentId = encodeStorageKeyToDocumentId(key);
  try {
    return decodeDocumentFields(await firestoreFetch(config, "GET", documentUrl(config, documentId)), key);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function storageConflict(message) {
  const error = new Error(message);
  error.name = "StorageConflictError";
  return error;
}

function isAmbiguousPreconditionFailure(error) {
  return error?.status === 400 && ["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(error?.firestoreStatus);
}

async function compareAndSwapDocument(config, key, expectedVersion, value) {
  validateStorageKey(key);
  const documentId = encodeStorageKeyToDocumentId(key);
  const query = expectedVersion === null
    ? "?currentDocument.exists=false"
    : `?currentDocument.updateTime=${encodeURIComponent(expectedVersion)}`;
  try {
    const document = await firestoreFetch(config, "PATCH", `${documentUrl(config, documentId)}${query}`, encodeDocumentFields(key, value));
    return { version: document.updateTime };
  } catch (error) {
    // Some Firestore backends return HTTP 400 FAILED_PRECONDITION instead of 409/412. Since that
    // status can also describe database configuration, classify it as CAS conflict only when a
    // read-back proves that the current document version differs from our precondition.
    let conflict = error?.status === 409 || error?.status === 412;
    if (!conflict && isAmbiguousPreconditionFailure(error)) {
      const current = await getDocument(config, key).catch(() => undefined);
      conflict = current !== undefined && (current?.version ?? null) !== expectedVersion;
    }
    if (conflict) throw storageConflict(`Firestore write conflict for ${key}: the document changed or already exists; read the latest version and retry`);
    throw error;
  }
}

async function deleteDocument(config, key, expectedVersion) {
  validateStorageKey(key);
  if (typeof expectedVersion !== "string" || !expectedVersion) throw new Error("expectedVersion is required for delete");
  const documentId = encodeStorageKeyToDocumentId(key);
  const query = `?currentDocument.updateTime=${encodeURIComponent(expectedVersion)}`;
  try {
    await firestoreFetch(config, "DELETE", `${documentUrl(config, documentId)}${query}`);
  } catch (error) {
    let conflict = error?.status === 409 || error?.status === 412 || error?.status === 404;
    if (!conflict && isAmbiguousPreconditionFailure(error)) {
      const current = await getDocument(config, key).catch(() => undefined);
      conflict = current !== undefined && current?.version !== expectedVersion;
    }
    if (conflict) throw storageConflict(`Firestore delete conflict for ${key}: the document changed or does not exist`);
    throw error;
  }
}

const LIST_PAGE_SIZE = 300;

/** Pages through every document in the collection, decoding only our own document IDs. */
async function forEachDocument(config, visit) {
  let pageToken;
  do {
    const url = new URL(collectionUrl(config));
    url.searchParams.set("pageSize", String(config.listPageSize ?? LIST_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await firestoreFetch(config, "GET", url.toString());
    for (const document of page?.documents ?? []) {
      const documentId = String(document.name ?? "").split("/").at(-1);
      const key = tryDecodeStorageKeyFromDocumentId(documentId);
      if (key !== undefined) visit(key, document);
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);
}

async function listStorageKeys(config, prefix) {
  const keys = [];
  await forEachDocument(config, (key) => { if (key.startsWith(prefix)) keys.push(key); });
  return keys.sort((left, right) => left.localeCompare(right));
}

/** Fetches every stored document (key, value, version), used by `pull`/`status`. */
async function listAllDocuments(config) {
  const entries = [];
  await forEachDocument(config, (key, document) => { entries.push(decodeDocumentFields(document, key)); });
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

// ---------------------------------------------------------------------------------------------
// WorkspaceStorageProviderV1
// ---------------------------------------------------------------------------------------------

export function createWorkspaceStorageProvider(defaultOptions = {}) {
  return {
    apiVersion: 1,
    async list(prefix) {
      if (typeof prefix !== "string") throw new Error("storage prefix must be a string");
      const config = await resolveConfiguration(defaultOptions);
      return listStorageKeys(config, prefix);
    },
    async read(key) {
      validateStorageKey(key);
      const config = await resolveConfiguration(defaultOptions);
      const document = await getDocument(config, key);
      return document ? { version: document.version, value: structuredClone(document.value) } : null;
    },
    async compareAndSwap(key, expectedVersion, value) {
      validateStorageKey(key);
      const config = await resolveConfiguration(defaultOptions);
      return compareAndSwapDocument(config, key, expectedVersion, value);
    },
    async delete(key, expectedVersion) {
      validateStorageKey(key);
      const config = await resolveConfiguration(defaultOptions);
      await deleteDocument(config, key, expectedVersion);
    },
  };
}

/**
 * Factory export used by the manifest `storage_provider`. `loadPluginStorageProvider` calls this
 * once with a `PluginRuntimeContextV1` (workspaceRoot, pluginDirectory, configuration,
 * credentials, env) and uses the returned `WorkspaceStorageProviderV1` as the loaded provider.
 */
export function createWorkspaceStorageProviderFromContext(context = {}) {
  return createWorkspaceStorageProvider({
    env: isPlainObject(context) ? context.env : undefined,
    configuration: isPlainObject(context) ? context.configuration : undefined,
    credentials: isPlainObject(context) ? context.credentials : undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Commands: push / pull / status
// ---------------------------------------------------------------------------------------------

function parseArgs(args) {
  const result = { dryRun: false };
  const values = [...args];
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--dry-run") { result.dryRun = true; continue; }
    const match = /^(--collection|--database)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    const value = match[2] ?? values[++index];
    if (!value || value.startsWith("--")) throw new Error(`${match[1]} requires a value`);
    result[match[1] === "--collection" ? "collectionId" : "databaseId"] = value;
  }
  return result;
}

function commandOptions(context) {
  if (!isPlainObject(context) || typeof context.workspaceRoot !== "string" || !Array.isArray(context.args)) throw new Error("invalid PluginCommandContext");
  return {
    workspaceRoot: context.workspaceRoot,
    configuration: isPlainObject(context.configuration) ? context.configuration : {},
    credentials: isPlainObject(context.credentials) ? context.credentials : {},
    ...parseArgs(context.args),
  };
}

export async function pushCommand(context) {
  const options = commandOptions(context);
  // Validate required project/config even for a no-network dry run.
  await resolveConfiguration(options, { requireToken: !options.dryRun });
  const localFiles = collectLocalFiles(options.workspaceRoot);
  if (options.dryRun) {
    console.log(`Would push ${localFiles.length} file(s)`);
    return;
  }
  const config = await resolveConfiguration(options);
  let pushed = 0;
  for (const file of localFiles) {
    const current = await getDocument(config, file.key);
    await compareAndSwapDocument(config, file.key, current ? current.version : null, file.value);
    pushed += 1;
  }
  console.log(`Pushed ${pushed} file(s)`);
}

export async function pullCommand(context) {
  const options = commandOptions(context);
  // Reading the remote documents always requires the network, even for a `--dry-run`; only the
  // local write is skipped in that case.
  const config = await resolveConfiguration(options);
  const remoteDocuments = await listAllDocuments(config);
  const files = remoteDocuments.map((document) => ({ path: storageKeyToLocalPath(document.key), value: document.value }));
  const paths = applyRemoteFiles(files, options.workspaceRoot, { dryRun: options.dryRun });
  console.log(`${options.dryRun ? "Would write" : "Wrote"} ${paths.length} file(s)`);
}

export async function statusCommand(context) {
  const options = commandOptions(context);
  if (options.dryRun) throw new Error("--dry-run is only valid for push and pull");
  const config = await resolveConfiguration(options);
  const [localFiles, remoteDocuments] = await Promise.all([
    Promise.resolve(collectLocalFiles(options.workspaceRoot)),
    listAllDocuments(config),
  ]);
  const localByKey = new Map(localFiles.map((file) => [file.key, stableStringify(file.value)]));
  const remoteByKey = new Map(remoteDocuments.map((document) => [document.key, stableStringify(document.value)]));
  const changes = [...new Set([...localByKey.keys(), ...remoteByKey.keys()])].sort().map((key) => ({
    key,
    status: !remoteByKey.has(key) ? "local-only" : !localByKey.has(key) ? "remote-only" : localByKey.get(key) === remoteByKey.get(key) ? "unchanged" : "modified",
  }));
  const visible = changes.filter(({ status }) => status !== "unchanged");
  if (visible.length === 0) console.log(`Up to date (${changes.length} file(s))`);
  else for (const entry of visible) console.log(`${entry.status}\t${entry.key}`);
  return changes;
}
