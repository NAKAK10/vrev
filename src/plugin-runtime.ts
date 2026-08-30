import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readPluginManifest, type PluginModuleReference, type VisualReviewPluginManifest } from "./plugin-manifest.js";
import { installedPluginDirectory, listPlugins } from "./plugin-registry.js";

export interface PluginCommandContext {
  workspaceRoot: string;
  pluginDirectory: string;
  args: readonly string[];
}

export type PluginCommandHandler = (context: PluginCommandContext) => void | Promise<void>;
export type PluginStorageProvider = object;

export interface PluginIssueDraft {
  title: string;
  body: string;
}

export interface PluginIssueResult {
  url: string;
}

export interface PluginIssueProvider {
  createIssue(projectRoot: string, draft: PluginIssueDraft): Promise<PluginIssueResult>;
}

export interface LoadedPluginCommand {
  manifest: VisualReviewPluginManifest;
  handler: PluginCommandHandler;
}

export interface LoadedPluginStorageProvider<T extends PluginStorageProvider = PluginStorageProvider> {
  manifest: VisualReviewPluginManifest;
  provider: T;
}

export interface LoadedPluginIssueProvider {
  manifest: VisualReviewPluginManifest;
  provider: PluginIssueProvider;
}

function installedManifest(id: string, workspace: string): { directory: string; manifest: VisualReviewPluginManifest } {
  const entry = listPlugins(workspace).find((plugin) => plugin.id === id);
  if (!entry) throw new Error(`plugin is not installed: ${id}`);
  const directory = installedPluginDirectory(id, workspace);
  if (lstatSync(directory).isSymbolicLink()) throw new Error("installed plugin directory must not be a symbolic link");
  const manifest = readPluginManifest(directory, true);
  if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest)) throw new Error("installed plugin manifest does not match the registry");
  return { directory, manifest };
}

async function loadExport(directory: string, reference: PluginModuleReference): Promise<unknown> {
  const parts = reference.module.slice(2).split("/");
  let modulePath = directory;
  for (const part of parts) {
    modulePath = path.join(modulePath, part);
    if (!existsSync(modulePath) || lstatSync(modulePath).isSymbolicLink()) throw new Error(`plugin module is missing or unsafe: ${reference.module}`);
  }
  const realModule = realpathSync(modulePath);
  const relative = path.relative(realpathSync(directory), realModule);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("plugin module resolves outside its directory");
  const digest = createHash("sha256").update(readFileSync(realModule)).digest("hex");
  const moduleUrl = pathToFileURL(realModule);
  moduleUrl.searchParams.set("v", digest);
  const loaded = await import(moduleUrl.href) as Record<string, unknown>;
  const exportName = reference.export ?? "default";
  if (!(exportName in loaded)) throw new Error(`plugin module does not export ${exportName}`);
  return loaded[exportName];
}

export async function loadPluginCommand(id: string, name: string, workspace = process.cwd()): Promise<LoadedPluginCommand> {
  const installed = installedManifest(id, workspace);
  const command = installed.manifest.commands?.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`plugin command is not declared: ${id}/${name}`);
  const handler = await loadExport(installed.directory, command);
  if (typeof handler !== "function") throw new Error(`plugin command export is not a function: ${id}/${name}`);
  return { manifest: installed.manifest, handler: handler as PluginCommandHandler };
}

export async function loadPluginStorageProvider<T extends PluginStorageProvider = PluginStorageProvider>(id: string, workspace = process.cwd()): Promise<LoadedPluginStorageProvider<T>> {
  const installed = installedManifest(id, workspace);
  if (!installed.manifest.storage_provider) throw new Error(`plugin does not declare a storage provider: ${id}`);
  const provider = await loadExport(installed.directory, installed.manifest.storage_provider);
  if ((typeof provider !== "object" || provider === null) && typeof provider !== "function") throw new Error(`plugin storage provider export is invalid: ${id}`);
  return { manifest: installed.manifest, provider: provider as T };
}

export async function loadPluginIssueProvider(id: string, workspace = process.cwd()): Promise<LoadedPluginIssueProvider> {
  const installed = installedManifest(id, workspace);
  if (!installed.manifest.issue_provider) throw new Error(`plugin does not declare an issue provider: ${id}`);
  const provider = await loadExport(installed.directory, installed.manifest.issue_provider);
  if (typeof provider !== "object" || provider === null || typeof (provider as { createIssue?: unknown }).createIssue !== "function") {
    throw new Error(`plugin issue provider export is invalid: ${id}`);
  }
  return { manifest: installed.manifest, provider: provider as PluginIssueProvider };
}
