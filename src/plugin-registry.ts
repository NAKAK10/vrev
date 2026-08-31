import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import { findWorkspaceRoot } from "./paths.js";
import { parsePluginManifest, readPluginManifest, type VisualReviewPluginManifest } from "./plugin-manifest.js";

export interface InstalledPlugin {
  id: string;
  version: string;
  source: string;
  installed_at: string;
  manifest: VisualReviewPluginManifest;
}

export interface PluginRegistry {
  schema_version: 1;
  plugins: InstalledPlugin[];
}

export interface PluginInstallResult {
  plugin: InstalledPlugin;
  directory: string;
}

export interface BundledPluginUpgradeResult extends PluginInstallResult {
  previousVersion: string;
}

interface TarEntry { name: string; data?: Buffer }

function storagePaths(workspace = process.cwd()): { registry: string; plugins: string; vreview: string } {
  const root = findWorkspaceRoot(workspace);
  const vreview = path.join(root, ".vreview");
  if (existsSync(vreview) && lstatSync(vreview).isSymbolicLink()) throw new Error("plugin storage path must not contain symbolic links");
  const plugins = path.join(vreview, "plugins");
  if (existsSync(plugins) && lstatSync(plugins).isSymbolicLink()) throw new Error("plugin storage path must not contain symbolic links");
  return { registry: path.join(vreview, "plugins.json"), plugins, vreview };
}

function validateSource(source: string): void {
  if (!source.trim() || source !== source.trim() || /[\0-\x1f\x7f]/.test(source)) throw new Error("plugin source must be a nonblank value without control characters");
  const candidate = source.replace(/^git\+/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let url: URL;
    try { url = new URL(candidate); } catch { throw new Error("plugin source URL is invalid"); }
    if (url.username || url.password) throw new Error("plugin source URL must not contain credentials");
    for (const key of url.searchParams.keys()) {
      if (/(?:auth|token|secret|password|api[-_]?key)/i.test(key)) throw new Error("plugin source URL must not contain credential parameters");
    }
  }
}

function ensurePluginIgnores(vreview: string): void {
  mkdirSync(vreview, { recursive: true });
  const ignorePath = path.join(vreview, ".gitignore");
  if (existsSync(ignorePath) && lstatSync(ignorePath).isSymbolicLink()) throw new Error("plugin storage ignore file must not be a symbolic link");
  const required = ["plugins/", "plugins.json", "plugin-settings.json", "custom-commands.json"];
  const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
  writeFileSync(ignorePath, `${[...new Set([...current, ...required])].join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function emptyRegistry(): PluginRegistry {
  return { schema_version: 1, plugins: [] };
}

function parseRegistry(value: unknown): PluginRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin registry must be an object");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.plugins)) throw new Error("plugin registry is invalid");
  const plugins = record.plugins.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("plugin registry entry is invalid");
    const entry = item as Record<string, unknown>;
    const manifest = parsePluginManifest(entry.manifest);
    if (entry.id !== manifest.id || entry.version !== manifest.version || typeof entry.source !== "string" || typeof entry.installed_at !== "string") {
      throw new Error("plugin registry entry is invalid");
    }
    return { id: manifest.id, version: manifest.version, source: entry.source, installed_at: entry.installed_at, manifest };
  });
  if (new Set(plugins.map(({ id }) => id)).size !== plugins.length) throw new Error("plugin registry contains duplicate ids");
  return { schema_version: 1, plugins };
}

function readRegistry(registryPath: string): PluginRegistry {
  return existsSync(registryPath) ? parseRegistry(readJson(registryPath)) : emptyRegistry();
}

function assertSafeTree(directory: string): void {
  if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) throw new Error("plugin source must be a directory without symbolic links");
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = entry.name;
      const child = path.join(current, name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) throw new Error(`plugin source contains a symbolic link: ${name}`);
      if (metadata.isDirectory()) visit(child);
      else if (!metadata.isFile()) throw new Error(`plugin source contains an unsupported file: ${name}`);
    }
  };
  visit(directory);
}

function copySafeTree(source: string, destination: string): void {
  assertSafeTree(source);
  cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false });
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} timed out after 60 seconds`));
    }, 60_000);
    timer.unref();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 1024 * 1024) stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) finish(new Error(`${command} exited with ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
      else if (size > 1024 * 1024) finish(new Error(`${command} output exceeded 1 MiB`));
      else finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function tarString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  return block.subarray(offset, end < 0 || end > offset + length ? offset + length : end).toString("utf8");
}

function safeArchiveName(rawName: string): string | null {
  if (rawName.includes("\\") || rawName.startsWith("/") || path.win32.isAbsolute(rawName)) throw new Error("npm archive contains an unsafe path");
  const parts = rawName.replace(/\/$/, "").split("/");
  if (parts[0] !== "package" || parts.some((part) => !part || part === "." || part === "..")) throw new Error("npm archive contains an unsafe path");
  if (parts.length === 1) return null;
  return parts.slice(1).join("/");
}

function inspectTar(archive: Buffer): TarEntry[] {
  const data = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = `${tarString(header, 345, 155)}${tarString(header, 345, 155) ? "/" : ""}${tarString(header, 0, 100)}`;
    const sizeText = tarString(header, 124, 12).trim().replace(/\0/g, "");
    if (!/^[0-7]*$/.test(sizeText)) throw new Error("npm archive has an invalid file size");
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const relative = safeArchiveName(name);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || bodyEnd > data.length) throw new Error("npm archive is truncated");
    if (type !== "\0" && type !== "0" && type !== "5") throw new Error("npm archive contains links or unsupported entries");
    if (relative !== null) {
      if (names.has(relative)) throw new Error("npm archive contains duplicate paths");
      names.add(relative);
      entries.push(type === "5" ? { name: relative } : { name: relative, data: data.subarray(bodyStart, bodyEnd) });
      if (entries.length > 20_000) throw new Error("npm archive contains too many entries");
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function extractNpmArchive(archivePath: string, destination: string): void {
  if (statSync(archivePath).size > 100 * 1024 * 1024) throw new Error("npm archive exceeds 100 MiB");
  const entries = inspectTar(readFileSync(archivePath));
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, ...entry.name.split("/"));
    if (entry.data === undefined) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.data, { flag: "wx", mode: 0o600 });
    }
  }
}

async function prepareSource(source: string, cwd: string, temporaryRoot: string): Promise<{ directory: string; recordedSource: string }> {
  const local = path.resolve(cwd, source);
  if (existsSync(local)) {
    if (lstatSync(local).isSymbolicLink()) throw new Error("plugin source must not be a symbolic link");
    const prepared = path.join(temporaryRoot, "plugin");
    copySafeTree(local, prepared);
    return { directory: prepared, recordedSource: local };
  }
  const packDirectory = path.join(temporaryRoot, "pack");
  mkdirSync(packDirectory);
  const output = await run("npm", ["pack", source, "--json", "--ignore-scripts"], packDirectory);
  let result: unknown;
  try { result = JSON.parse(output) as unknown; } catch { throw new Error("npm pack returned invalid JSON"); }
  const filename = Array.isArray(result) && result.length === 1 && typeof (result[0] as { filename?: unknown })?.filename === "string"
    ? (result[0] as { filename: string }).filename : null;
  if (filename === null || path.basename(filename) !== filename) throw new Error("npm pack did not return a safe archive filename");
  const prepared = path.join(temporaryRoot, "plugin");
  extractNpmArchive(path.join(packDirectory, filename), prepared);
  return { directory: prepared, recordedSource: source };
}

export async function installPlugin(source: string, workspace = process.cwd()): Promise<PluginInstallResult> {
  validateSource(source);
  const paths = storagePaths(workspace);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "visual-review-plugin-"));
  try {
    const prepared = await prepareSource(source, path.resolve(workspace), temporaryRoot);
    const manifest = readPluginManifest(prepared.directory, true);
    return withFileLock(paths.registry, () => {
      const registry = readRegistry(paths.registry);
      if (registry.plugins.some(({ id }) => id === manifest.id)) throw new Error(`plugin is already installed: ${manifest.id}`);
      ensurePluginIgnores(paths.vreview);
      mkdirSync(paths.plugins, { recursive: true });
      const staging = path.join(paths.plugins, `.${manifest.id}.${randomUUID()}.tmp`);
      const destination = path.join(paths.plugins, manifest.id);
      if (existsSync(destination)) throw new Error(`plugin directory already exists: ${manifest.id}`);
      const plugin: InstalledPlugin = { id: manifest.id, version: manifest.version, source: prepared.recordedSource, installed_at: new Date().toISOString(), manifest };
      try {
        copySafeTree(prepared.directory, staging);
        renameSync(staging, destination);
        atomicWriteJson(paths.registry, { schema_version: 1, plugins: [...registry.plugins, plugin] });
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
      return { plugin, directory: destination };
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): { core: bigint[]; prerelease: string[] | null } => {
    const buildIndex = value.indexOf("+");
    const withoutBuild = buildIndex < 0 ? value : value.slice(0, buildIndex);
    const prereleaseIndex = withoutBuild.indexOf("-");
    const coreText = prereleaseIndex < 0 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
    const prereleaseText = prereleaseIndex < 0 ? null : withoutBuild.slice(prereleaseIndex + 1);
    return {
      core: coreText.split(".").map(BigInt),
      prerelease: prereleaseText === null ? null : prereleaseText.split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! !== b.core[index]!) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return BigInt(aPart) < BigInt(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function isOlderBundledManifest(installed: VisualReviewPluginManifest, bundled: VisualReviewPluginManifest): boolean {
  const schemaComparison = installed.schema_version - bundled.schema_version;
  const versionComparison = compareSemver(installed.version, bundled.version);
  return schemaComparison <= 0 && versionComparison <= 0 && (schemaComparison < 0 || versionComparison < 0);
}

/**
 * Replaces an outdated bundled copy only when the registry and on-disk state
 * still prove that it was installed from this exact bundled source.
 */
export function upgradeBundledPlugin(
  source: string,
  workspace = process.cwd(),
): BundledPluginUpgradeResult | null {
  if (!path.isAbsolute(source)) throw new Error("bundled plugin source must be absolute");
  assertSafeTree(source);
  const bundledManifest = readPluginManifest(source, true);
  if (path.basename(source) !== bundledManifest.id) throw new Error("bundled plugin directory and manifest id do not match");
  const paths = storagePaths(workspace);

  return withFileLock(paths.registry, () => {
    const registry = readRegistry(paths.registry);
    const index = registry.plugins.findIndex(({ id }) => id === bundledManifest.id);
    if (index < 0) return null;
    const existing = registry.plugins[index]!;
    if (!path.isAbsolute(existing.source) || path.resolve(existing.source) !== path.resolve(source)) return null;

    const destination = path.join(paths.plugins, existing.id);
    let installedManifest: VisualReviewPluginManifest;
    try {
      if (!existsSync(destination)) return null;
      assertSafeTree(destination);
      installedManifest = readPluginManifest(destination, true);
    } catch {
      return null;
    }
    if (installedManifest.id !== existing.id
      || bundledManifest.id !== existing.id
      || !isDeepStrictEqual(installedManifest, existing.manifest)
      || !isOlderBundledManifest(installedManifest, bundledManifest)) return null;

    const staging = path.join(paths.plugins, `.${existing.id}.${randomUUID()}.upgrade`);
    const backup = path.join(paths.plugins, `.${existing.id}.${randomUUID()}.backup`);
    const plugin: InstalledPlugin = {
      id: bundledManifest.id,
      version: bundledManifest.version,
      source,
      installed_at: new Date().toISOString(),
      manifest: bundledManifest,
    };
    let oldMoved = false;
    let replacementMoved = false;
    try {
      copySafeTree(source, staging);
      renameSync(destination, backup);
      oldMoved = true;
      renameSync(staging, destination);
      replacementMoved = true;
      const plugins = [...registry.plugins];
      plugins[index] = plugin;
      atomicWriteJson(paths.registry, { schema_version: 1, plugins });
    } catch (error) {
      if (replacementMoved) rmSync(destination, { recursive: true, force: true });
      if (oldMoved) renameSync(backup, destination);
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return { plugin, directory: destination, previousVersion: existing.version };
  });
}

export function listPlugins(workspace = process.cwd()): InstalledPlugin[] {
  const paths = storagePaths(workspace);
  return withFileLock(paths.registry, () => readRegistry(paths.registry).plugins);
}

export function removePlugin(id: string, workspace = process.cwd()): void {
  const paths = storagePaths(workspace);
  withFileLock(paths.registry, () => {
    const registry = readRegistry(paths.registry);
    const index = registry.plugins.findIndex((plugin) => plugin.id === id);
    if (index < 0) throw new Error(`plugin is not installed: ${id}`);
    const destination = path.join(paths.plugins, id);
    if (!existsSync(destination) || lstatSync(destination).isSymbolicLink()) throw new Error("installed plugin directory is missing or unsafe");
    const trash = path.join(paths.plugins, `.${id}.${randomUUID()}.remove`);
    renameSync(destination, trash);
    try {
      atomicWriteJson(paths.registry, { schema_version: 1, plugins: registry.plugins.filter((_, entryIndex) => entryIndex !== index) });
    } catch (error) {
      renameSync(trash, destination);
      throw error;
    }
    rmSync(trash, { recursive: true, force: true });
  });
}

export function installedPluginDirectory(id: string, workspace = process.cwd()): string {
  const paths = storagePaths(workspace);
  const plugin = listPlugins(workspace).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`plugin is not installed: ${id}`);
  return path.join(paths.plugins, plugin.id);
}
