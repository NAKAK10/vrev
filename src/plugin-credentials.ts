import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import { findWorkspaceRoot } from "./paths.js";

const CREDENTIAL_SCHEMA_VERSION = 1;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const CREDENTIAL_DIR_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;

export interface PluginCredentialEntry {
  value: string;
  updated_at: string;
}

export interface PluginCredentialsFile {
  schema_version: 1;
  values: Record<string, PluginCredentialEntry>;
}

export interface PluginCredentialPresence {
  present: true;
  updated_at: string;
  fingerprint: string;
}

function credentialsDirectory(workspace: string): string {
  const root = findWorkspaceRoot(workspace);
  return path.join(root, ".vrev", "credentials");
}

function assertNotSymlink(target: string, label: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
}

function credentialsPath(pluginId: string, workspace: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(pluginId)) throw new Error("plugin id is invalid");
  const directory = credentialsDirectory(workspace);
  assertNotSymlink(directory, "plugin credential store directory");
  const filePath = path.join(directory, `${pluginId}.json`);
  assertNotSymlink(filePath, "plugin credential store");
  return filePath;
}

function emptyCredentials(): PluginCredentialsFile {
  return { schema_version: CREDENTIAL_SCHEMA_VERSION, values: {} };
}

function parseCredentials(value: unknown): PluginCredentialsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin credential store must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema_version", "values"].includes(key)) || record.schema_version !== CREDENTIAL_SCHEMA_VERSION
    || typeof record.values !== "object" || record.values === null || Array.isArray(record.values)) {
    throw new Error("plugin credential store schema is invalid");
  }
  const values: Record<string, PluginCredentialEntry> = {};
  for (const [key, raw] of Object.entries(record.values as Record<string, unknown>)) {
    if (!KEY_PATTERN.test(key)) throw new Error(`plugin credential key is invalid: ${key}`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`plugin credential entry is invalid: ${key}`);
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((field) => !["value", "updated_at"].includes(field))
      || typeof entry.value !== "string" || typeof entry.updated_at !== "string" || !Number.isFinite(Date.parse(entry.updated_at))) {
      throw new Error(`plugin credential entry is invalid: ${key}`);
    }
    values[key] = { value: entry.value, updated_at: entry.updated_at };
  }
  return { schema_version: CREDENTIAL_SCHEMA_VERSION, values };
}

function readStore(pluginId: string, workspace: string): PluginCredentialsFile {
  const filePath = credentialsPath(pluginId, workspace);
  if (!existsSync(filePath)) return emptyCredentials();
  return parseCredentials(readJson(filePath));
}

function ensureCredentialsIgnored(workspace: string): void {
  const root = findWorkspaceRoot(workspace);
  const ignorePath = path.join(root, ".vrev", ".gitignore");
  assertNotSymlink(ignorePath, "plugin credential ignore file");
  const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  if (current.includes("credentials/")) return;
  writeFileSync(ignorePath, `${[...new Set([...current, "credentials/"])].join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function validateKey(pluginId: string, key: string, workspace: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("plugin credential key is invalid");
  void credentialsPath(pluginId, workspace);
}

function validateValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("plugin credential value must be a string");
  if (/\u0000/.test(value)) throw new Error("plugin credential value must not contain NUL characters");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new Error("plugin credential value is too large");
  return value;
}

export function readPluginCredentialPresence(pluginId: string, workspace = process.cwd()): Record<string, PluginCredentialPresence> {
  const store = readStore(pluginId, workspace);
  const result: Record<string, PluginCredentialPresence> = {};
  for (const [key, entry] of Object.entries(store.values)) {
    result[key] = {
      present: true,
      updated_at: entry.updated_at,
      fingerprint: createHash("sha256").update(entry.value, "utf8").digest("hex").slice(0, 8),
    };
  }
  return result;
}

export function readPluginCredentials(pluginId: string, workspace = process.cwd(), keys: string[]): Record<string, string> {
  const store = readStore(pluginId, workspace);
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) continue;
    const entry = store.values[key];
    if (entry) result[key] = entry.value;
  }
  return result;
}

export function setPluginCredential(pluginId: string, key: string, value: string, workspace = process.cwd()): void {
  validateKey(pluginId, key, workspace);
  const validValue = validateValue(value);
  const filePath = credentialsPath(pluginId, workspace);
  // Create the directory with the restrictive mode before `withFileLock` can create it (with a
  // permissive default mode) while writing its own lock file.
  if (!existsSync(path.dirname(filePath))) mkdirSync(path.dirname(filePath), { recursive: true, mode: CREDENTIAL_DIR_MODE });
  withFileLock(filePath, () => {
    const store = readStore(pluginId, workspace);
    store.values[key] = { value: validValue, updated_at: new Date().toISOString() };
    ensureCredentialsIgnored(workspace);
    atomicWriteJson(filePath, store, { mode: CREDENTIAL_FILE_MODE, dirMode: CREDENTIAL_DIR_MODE });
  });
}

export function deletePluginCredential(pluginId: string, key: string, workspace = process.cwd()): void {
  validateKey(pluginId, key, workspace);
  const filePath = credentialsPath(pluginId, workspace);
  withFileLock(filePath, () => {
    if (!existsSync(filePath)) return;
    const store = readStore(pluginId, workspace);
    if (!(key in store.values)) return;
    delete store.values[key];
    atomicWriteJson(filePath, store, { mode: CREDENTIAL_FILE_MODE, dirMode: CREDENTIAL_DIR_MODE });
  });
}

export function pluginCredentialsPath(pluginId: string, workspace = process.cwd()): string {
  return credentialsPath(pluginId, workspace);
}
