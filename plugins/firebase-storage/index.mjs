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

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_COLLECTION_ID = "visual-review-workspaces";
const DEFAULT_DOCUMENT_ID = "default";
const DEFAULT_DATABASE_ID = "(default)";
const MAX_PAYLOAD_BYTES = 850 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUNTIME_NAMES = new Set(["job-state.json", ".server-lease.json", ".transaction.json"]);
const SECRET_SEGMENT = /^(?:secret|secrets|credential|credentials|token|tokens)(?:[._-].*)?$/i;

function ownObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (ownObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

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

function parseJsonFile(workspaceRoot, relativePath) {
  const filePath = safeLocalPath(workspaceRoot, relativePath);
  const stat = lstatSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`JSON file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

function reviewJsonPaths(workspaceRoot) {
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

export function collectLocalSnapshot(workspaceRoot = process.cwd()) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const paths = [];
  const settings = path.join(root, ".vreview", "settings.json");
  if (existsSync(settings)) paths.push(".vreview/settings.json");
  paths.push(...reviewJsonPaths(root));
  if (paths.length > MAX_FILES) throw new Error(`workspace contains more than ${MAX_FILES} synchronizable files`);
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    files: [...new Set(paths)].sort().map((relativePath) => ({ path: relativePath, value: parseJsonFile(root, relativePath) })),
  };
  validateSnapshot(snapshot);
  return snapshot;
}

export function validateSnapshot(value) {
  if (!ownObject(value)) throw new Error("remote payload must be an object");
  exactKeys(value, ["schema_version", "files"], "remote payload");
  if (value.schema_version !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(value.files)) throw new Error("remote payload has an unsupported schema");
  if (value.files.length > MAX_FILES) throw new Error(`remote payload contains more than ${MAX_FILES} files`);
  const seen = new Set();
  let previous = "";
  for (const [index, file] of value.files.entries()) {
    if (!ownObject(file)) throw new Error(`remote payload files[${index}] must be an object`);
    exactKeys(file, ["path", "value"], `remote payload files[${index}]`);
    validateRelativePath(file.path);
    if (seen.has(file.path)) throw new Error(`remote payload contains duplicate path: ${file.path}`);
    const segments = file.path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const prefix = segments.slice(0, end).join("/");
      if (seen.has(prefix)) throw new Error(`remote payload contains file/directory path conflict: ${prefix} and ${file.path}`);
    }
    for (const prior of seen) {
      if (prior.startsWith(`${file.path}/`)) throw new Error(`remote payload contains file/directory path conflict: ${file.path} and ${prior}`);
    }
    if (previous && file.path.localeCompare(previous) < 0) throw new Error("remote payload file paths must be sorted");
    seen.add(file.path);
    previous = file.path;
    const encoded = JSON.stringify(file.value);
    if (encoded === undefined) throw new Error(`remote payload contains a non-JSON value: ${file.path}`);
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error(`remote JSON file exceeds ${MAX_FILE_BYTES} bytes: ${file.path}`);
  }
  const bytes = Buffer.byteLength(stableStringify(value));
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`snapshot exceeds the safe Firestore payload limit of ${MAX_PAYLOAD_BYTES} bytes`);
  return value;
}

function validateId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value === "." || value === ".." || /^__.*__$/.test(value)) {
    throw new Error(`${label} must be 1-128 letters, numbers, dots, underscores, or hyphens and must not be reserved`);
  }
  return value;
}

function configuration(options = {}, requireToken = true) {
  const env = options.env ?? process.env;
  const projectId = options.projectId ?? env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");
  const accessToken = options.accessToken ?? env.FIREBASE_ACCESS_TOKEN;
  if (requireToken && !accessToken) {
    const suffix = env.GOOGLE_APPLICATION_CREDENTIALS ? "; GOOGLE_APPLICATION_CREDENTIALS is not supported by this plugin" : "";
    throw new Error(`FIREBASE_ACCESS_TOKEN is required${suffix}`);
  }
  return {
    projectId: validateId(projectId, "Firebase project ID"),
    accessToken,
    collectionId: validateId(options.collectionId ?? env.FIREBASE_COLLECTION_ID ?? DEFAULT_COLLECTION_ID, "Firestore collection ID"),
    documentId: validateId(options.documentId ?? env.FIREBASE_DOCUMENT_ID ?? DEFAULT_DOCUMENT_ID, "Firestore document ID"),
    databaseId: (options.databaseId ?? env.FIREBASE_DATABASE_ID ?? DEFAULT_DATABASE_ID) === DEFAULT_DATABASE_ID
      ? DEFAULT_DATABASE_ID
      : validateId(options.databaseId ?? env.FIREBASE_DATABASE_ID, "Firestore database ID"),
    fetch: options.fetch ?? globalThis.fetch,
  };
}

function documentUrl(config) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/${encodeURIComponent(config.databaseId)}/documents/${encodeURIComponent(config.collectionId)}/${encodeURIComponent(config.documentId)}`;
}

async function firestoreRequest(config, method, body, query = "") {
  if (typeof config.fetch !== "function") throw new Error("Node.js fetch is unavailable");
  const response = await config.fetch(`${documentUrl(config)}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value;
  if (text) {
    try { value = JSON.parse(text); } catch { throw new Error(`Firestore returned non-JSON response (HTTP ${response.status})`); }
  }
  if (!response.ok) {
    const message = ownObject(value) && ownObject(value.error) && typeof value.error.message === "string" ? value.error.message : `HTTP ${response.status}`;
    const error = new Error(`Firestore request failed: ${message}`);
    error.status = response.status;
    throw error;
  }
  return value;
}

function decodeDocument(document) {
  if (!ownObject(document) || !ownObject(document.fields)) throw new Error("Firestore document has no fields");
  const fields = document.fields;
  exactKeys(fields, ["schemaVersion", "payload", "digest", "updatedAt"], "Firestore document fields");
  if (fields.schemaVersion?.integerValue !== String(SNAPSHOT_SCHEMA_VERSION)) throw new Error("Firestore document has an unsupported schema");
  if (typeof fields.payload?.stringValue !== "string" || typeof fields.digest?.stringValue !== "string" || typeof fields.updatedAt?.timestampValue !== "string") {
    throw new Error("Firestore document fields have invalid types");
  }
  if (Buffer.byteLength(fields.payload.stringValue) > MAX_PAYLOAD_BYTES) throw new Error("Firestore payload exceeds the safe size limit");
  let snapshot;
  try { snapshot = JSON.parse(fields.payload.stringValue); } catch { throw new Error("Firestore payload is not valid JSON"); }
  validateSnapshot(snapshot);
  const actualDigest = digest(snapshot);
  if (fields.digest.stringValue !== actualDigest) throw new Error("Firestore payload digest does not match its content");
  if (!Number.isFinite(Date.parse(fields.updatedAt.timestampValue))) throw new Error("Firestore updatedAt is invalid");
  if (typeof document.updateTime !== "string" || !Number.isFinite(Date.parse(document.updateTime))) throw new Error("Firestore document updateTime is invalid");
  return { snapshot, digest: actualDigest, updatedAt: fields.updatedAt.timestampValue, updateTime: document.updateTime };
}

function encodeDocument(snapshot) {
  validateSnapshot(snapshot);
  const payload = stableStringify(snapshot);
  return {
    fields: {
      schemaVersion: { integerValue: String(SNAPSHOT_SCHEMA_VERSION) },
      payload: { stringValue: payload },
      digest: { stringValue: digest(snapshot) },
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  };
}

export async function readRemoteSnapshot(options = {}) {
  const config = configuration(options);
  return decodeDocument(await firestoreRequest(config, "GET"));
}

export async function writeRemoteSnapshot(snapshot, options = {}) {
  const config = configuration(options);
  if (options.updateTime && options.createOnly) throw new Error("updateTime and createOnly cannot be combined");
  const query = options.updateTime
    ? `?currentDocument.updateTime=${encodeURIComponent(options.updateTime)}`
    : options.createOnly ? "?currentDocument.exists=false" : "";
  return decodeDocument(await firestoreRequest(config, "PATCH", encodeDocument(snapshot), query));
}

async function writeWithPrecondition(snapshot, options, remote) {
  try {
    return await writeRemoteSnapshot(snapshot, {
      ...options,
      updateTime: remote?.updateTime,
      createOnly: remote === undefined,
    });
  } catch (error) {
    if (error?.status !== 412) throw error;
    const conflict = new Error("Firestore write conflict: the remote document changed; pull the latest snapshot and retry");
    conflict.status = 412;
    conflict.cause = error;
    throw conflict;
  }
}

async function readRemoteForWrite(options) {
  try {
    return await readRemoteSnapshot(options);
  } catch (error) {
    if (error?.status === 404) return undefined;
    throw error;
  }
}

function atomicWriteJson(workspaceRoot, relativePath, value) {
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

export function applySnapshot(snapshot, workspaceRoot = process.cwd(), { dryRun = false } = {}) {
  validateSnapshot(snapshot);
  const root = normalizeWorkspaceRoot(workspaceRoot);
  // Validate every destination before changing any file.
  for (const file of snapshot.files) safeLocalPath(root, file.path, true);
  if (dryRun || snapshot.files.length === 0) return snapshot.files.map((file) => file.path);

  const stageRoot = path.join(root, `.firebase-storage-stage-${process.pid}-${randomUUID()}`);
  const stagedFilesRoot = path.join(stageRoot, "files");
  const backupRoot = path.join(stageRoot, "backup");
  mkdirSync(stagedFilesRoot, { recursive: true, mode: 0o700 });
  let preserveStage = false;
  try {
    // Materialize and parse every file before touching any destination.
    for (const file of snapshot.files) atomicWriteJson(stagedFilesRoot, file.path, file.value);
    for (const file of snapshot.files) {
      const stagedValue = parseJsonFile(stagedFilesRoot, file.path);
      if (digest(stagedValue) !== digest(file.value)) throw new Error(`staged JSON validation failed: ${file.path}`);
    }

    const records = [];
    try {
      for (const file of snapshot.files) {
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
        throw new Error(`snapshot commit failed and rollback was incomplete; backups preserved at ${stageRoot}: ${rollbackErrors.join("; ")}`, { cause: commitError });
      }
      throw commitError;
    }
  } finally {
    if (!preserveStage) rmSync(stageRoot, { recursive: true, force: true });
  }
  return snapshot.files.map((file) => file.path);
}

function snapshotsByPath(snapshot) {
  return new Map(snapshot.files.map((file) => [file.path, digest(file.value)]));
}

export function compareSnapshots(local, remote) {
  validateSnapshot(local);
  validateSnapshot(remote);
  const localFiles = snapshotsByPath(local);
  const remoteFiles = snapshotsByPath(remote);
  return [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort().map((filePath) => ({
    path: filePath,
    status: !remoteFiles.has(filePath) ? "local-only" : !localFiles.has(filePath) ? "remote-only" : localFiles.get(filePath) === remoteFiles.get(filePath) ? "unchanged" : "modified",
  }));
}

function parseArgs(args) {
  const result = { dryRun: false };
  const values = [...args];
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--dry-run") { result.dryRun = true; continue; }
    const match = /^(--collection|--document|--database)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    const value = match[2] ?? values[++index];
    if (!value || value.startsWith("--")) throw new Error(`${match[1]} requires a value`);
    const key = match[1] === "--collection" ? "collectionId" : match[1] === "--document" ? "documentId" : "databaseId";
    result[key] = value;
  }
  return result;
}

function commandOptions(context) {
  if (!ownObject(context) || typeof context.workspaceRoot !== "string" || !Array.isArray(context.args)) throw new Error("invalid PluginCommandContext");
  return { workspaceRoot: context.workspaceRoot, ...parseArgs(context.args) };
}

export async function pushCommand(context) {
  const options = commandOptions(context);
  // Validate required project/config even for a no-network dry run.
  configuration(options, !options.dryRun);
  const snapshot = collectLocalSnapshot(options.workspaceRoot);
  if (!options.dryRun) {
    const remote = await readRemoteForWrite(options);
    await writeWithPrecondition(snapshot, options, remote);
  }
  console.log(`${options.dryRun ? "Would push" : "Pushed"} ${snapshot.files.length} file(s), digest ${digest(snapshot)}`);
}

export async function pullCommand(context) {
  const options = commandOptions(context);
  const remote = await readRemoteSnapshot(options);
  const paths = applySnapshot(remote.snapshot, options.workspaceRoot, { dryRun: options.dryRun });
  console.log(`${options.dryRun ? "Would write" : "Wrote"} ${paths.length} file(s), digest ${remote.digest}`);
}

export async function statusCommand(context) {
  const options = commandOptions(context);
  if (options.dryRun) throw new Error("--dry-run is only valid for push and pull");
  const [local, remote] = await Promise.all([Promise.resolve(collectLocalSnapshot(options.workspaceRoot)), readRemoteSnapshot(options)]);
  const changes = compareSnapshots(local, remote.snapshot);
  const visible = changes.filter(({ status }) => status !== "unchanged");
  if (visible.length === 0) console.log(`Up to date (${changes.length} file(s), digest ${remote.digest})`);
  else for (const entry of visible) console.log(`${entry.status}\t${entry.path}`);
  return changes;
}

export function createStorageProvider(defaultOptions = {}) {
  return {
    async list(options = {}) {
      const remote = await readRemoteSnapshot({ ...defaultOptions, ...options });
      return remote.snapshot.files.map((file) => ({ path: file.path, digest: digest(file.value) }));
    },
    async read(relativePath, options = {}) {
      validateRelativePath(relativePath);
      const remote = await readRemoteSnapshot({ ...defaultOptions, ...options });
      const file = remote.snapshot.files.find((candidate) => candidate.path === relativePath);
      return file ? structuredClone(file.value) : undefined;
    },
    async write(relativePath, value, options = {}) {
      validateRelativePath(relativePath);
      const merged = { ...defaultOptions, ...options };
      const remote = await readRemoteForWrite(merged);
      const currentSnapshot = remote?.snapshot ?? { schema_version: SNAPSHOT_SCHEMA_VERSION, files: [] };
      const files = currentSnapshot.files.filter((file) => file.path !== relativePath);
      files.push({ path: relativePath, value: structuredClone(value) });
      files.sort((left, right) => left.path.localeCompare(right.path));
      const snapshot = { schema_version: SNAPSHOT_SCHEMA_VERSION, files };
      const written = await writeWithPrecondition(snapshot, merged, remote);
      return { path: relativePath, digest: digest(value), updatedAt: written.updatedAt };
    },
  };
}

export const storageProvider = createStorageProvider();
export const list = storageProvider.list;
export const read = storageProvider.read;
export const write = storageProvider.write;
export default storageProvider;
