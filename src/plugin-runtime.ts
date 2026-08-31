import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parsePluginBridgeContract, type PluginBridgeContractV1 } from "./plugin-bridge-contract.js";
import { readPluginManifest, type PluginModuleReference, type VisualReviewPluginManifest } from "./plugin-manifest.js";
import { installedPluginDirectory, listPlugins } from "./plugin-registry.js";
import { assertPluginServerProviderV1, type PluginServerProviderV1 } from "./plugin-server.js";
import { assertPluginEnabled } from "./plugin-settings.js";
import { assertWorkspaceStorageProviderV1, type WorkspaceStorageProviderV1 } from "./storage-provider.js";

export interface PluginCommandContext {
  workspaceRoot: string;
  pluginDirectory: string;
  args: readonly string[];
  configuration?: Readonly<Record<string, string | number | boolean>>;
}

export type PluginCommandHandler = (context: PluginCommandContext) => void | Promise<void>;
export type PluginStorageProvider = object;

export type AnnotationFlowEventV1 = "annotation-created" | "annotation-reopened";

export interface AnnotationFlowPolicyV1 {
  events: AnnotationFlowEventV1[];
  debounceMs: number;
  settings: {
    runner: { label: string; options: Array<{ value: "opencode" | "claude" | "codex" | "copilot" | "pi"; label: string }> };
    maxParallel: { label: string; min: number; max: number; defaultValue: number };
    autoRun: { label: string };
  };
}

export interface PluginAnnotationFlowProviderV1 {
  readonly apiVersion: 1;
  policy(): AnnotationFlowPolicyV1;
}

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

export interface LoadedPluginAnnotationFlowProvider {
  manifest: VisualReviewPluginManifest;
  provider: PluginAnnotationFlowProviderV1;
  policy: AnnotationFlowPolicyV1;
}

export interface CustomCommandSummaryV1 { runner_id: string; name: string; verified: boolean; probe_ms: number | null }
export interface PluginCustomCommandProviderV1 {
  readonly apiVersion: 1;
  list(workspaceRoot: string): CustomCommandSummaryV1[];
  listPending?(workspaceRoot: string): Array<{ runner_id: string; name: string }>;
  add(workspaceRoot: string, name: string, template: string): Promise<{ runner_id: string; duration_ms: number }>;
  remove(workspaceRoot: string, runnerId: string): void;
  test(workspaceRoot: string, runnerId: string): Promise<{ duration_ms: number }>;
  resolve(workspaceRoot: string, runnerId: string): { name: string; template: string };
}
export interface LoadedPluginCustomCommandProvider { manifest: VisualReviewPluginManifest; provider: PluginCustomCommandProviderV1 }

function installedManifest(id: string, workspace: string, requireModules = true): { directory: string; manifest: VisualReviewPluginManifest } {
  const entry = listPlugins(workspace).find((plugin) => plugin.id === id);
  if (!entry) throw new Error(`plugin is not installed: ${id}`);
  const directory = installedPluginDirectory(id, workspace);
  if (lstatSync(directory).isSymbolicLink()) throw new Error("installed plugin directory must not be a symbolic link");
  const manifest = readPluginManifest(directory, requireModules);
  if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest)) throw new Error("installed plugin manifest does not match the registry");
  assertPluginEnabled(manifest, workspace);
  return { directory, manifest };
}

function safePluginFile(directory: string, reference: string): string {
  const parts = reference.slice(2).split("/");
  let modulePath = directory;
  for (const part of parts) {
    modulePath = path.join(modulePath, part);
    if (!existsSync(modulePath) || lstatSync(modulePath).isSymbolicLink()) throw new Error(`plugin module is missing or unsafe: ${reference}`);
  }
  const realModule = realpathSync(modulePath);
  if (!lstatSync(realModule).isFile()) throw new Error(`plugin module is missing or unsafe: ${reference}`);
  const relative = path.relative(realpathSync(directory), realModule);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("plugin module resolves outside its directory");
  return realModule;
}

async function loadExport(directory: string, reference: PluginModuleReference): Promise<unknown> {
  const realModule = safePluginFile(directory, reference.module);
  const digest = createHash("sha256").update(readFileSync(realModule)).digest("hex");
  const moduleUrl = pathToFileURL(realModule);
  moduleUrl.searchParams.set("v", digest);
  const loaded = await import(moduleUrl.href) as Record<string, unknown>;
  const exportName = reference.export ?? "default";
  if (!(exportName in loaded)) throw new Error(`plugin module does not export ${exportName}`);
  return loaded[exportName];
}

export interface LoadedPluginServerProvider {
  manifest: VisualReviewPluginManifest;
  pluginDirectory: string;
  contract: PluginBridgeContractV1;
  provider: PluginServerProviderV1;
}

/** Loads a v4 server contribution only after enablement has been checked. */
export async function loadPluginServerProvider(id: string, workspace = process.cwd()): Promise<LoadedPluginServerProvider> {
  // Server loading deliberately does not inspect UI contribution files.
  const installed = installedManifest(id, workspace, false);
  const server = installed.manifest.schema_version === 4 ? installed.manifest.server : undefined;
  if (!server) throw new Error(`plugin does not declare a v4 server contribution: ${id}`);
  const contractFile = safePluginFile(installed.directory, server.contract);
  let contractValue: unknown;
  try {
    contractValue = JSON.parse(readFileSync(contractFile, "utf8")) as unknown;
  } catch {
    throw new Error(`plugin bridge contract is not valid JSON: ${id}`);
  }
  const contract = parsePluginBridgeContract(contractValue);
  const provider = await loadExport(installed.directory, server);
  assertPluginServerProviderV1(provider);
  return { manifest: installed.manifest, pluginDirectory: installed.directory, contract, provider };
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
  if (installed.manifest.schema_version === 2) assertWorkspaceStorageProviderV1(provider);
  else if ((typeof provider !== "object" || provider === null) && typeof provider !== "function") throw new Error(`plugin storage provider export is invalid: ${id}`);
  return { manifest: installed.manifest, provider: provider as T };
}

export async function loadWorkspaceStorageProviderV1(id: string, workspace = process.cwd()): Promise<LoadedPluginStorageProvider<WorkspaceStorageProviderV1>> {
  const loaded = await loadPluginStorageProvider<WorkspaceStorageProviderV1>(id, workspace);
  assertWorkspaceStorageProviderV1(loaded.provider);
  return loaded;
}

function validateAnnotationFlowPolicy(provider: PluginAnnotationFlowProviderV1, id: string): AnnotationFlowPolicyV1 {
  const policy = provider.policy();
  const allowed = new Set<AnnotationFlowEventV1>(["annotation-created", "annotation-reopened"]);
  if (!Array.isArray(policy.events) || policy.events.length === 0 || policy.events.some((event) => !allowed.has(event)) || new Set(policy.events).size !== policy.events.length) {
    throw new Error(`plugin annotation flow policy events are invalid: ${id}`);
  }
  if (!Number.isInteger(policy.debounceMs) || policy.debounceMs < 0 || policy.debounceMs > 5_000) throw new Error(`plugin annotation flow debounceMs is invalid: ${id}`);
  const settings = policy.settings;
  const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 120;
  const runnerValues = new Set(["opencode", "claude", "codex", "copilot", "pi"]);
  if (!settings || !text(settings.runner?.label) || !Array.isArray(settings.runner.options) || settings.runner.options.length === 0
    || settings.runner.options.some((option) => !runnerValues.has(option.value) || !text(option.label))
    || new Set(settings.runner.options.map(({ value }) => value)).size !== settings.runner.options.length) {
    throw new Error(`plugin annotation flow runner settings are invalid: ${id}`);
  }
  const parallel = settings.maxParallel;
  if (!text(parallel?.label) || !Number.isInteger(parallel.min) || !Number.isInteger(parallel.max) || !Number.isInteger(parallel.defaultValue)
    || parallel.min < 1 || parallel.max > 10 || parallel.min > parallel.max || parallel.defaultValue < parallel.min || parallel.defaultValue > parallel.max) {
    throw new Error(`plugin annotation flow parallel settings are invalid: ${id}`);
  }
  if (!text(settings.autoRun?.label)) throw new Error(`plugin annotation flow auto-run settings are invalid: ${id}`);
  return structuredClone(policy);
}

async function loadedAnnotationFlow(installed: { directory: string; manifest: VisualReviewPluginManifest }, id: string): Promise<LoadedPluginAnnotationFlowProvider> {
  if (!installed.manifest.annotation_flow_provider) throw new Error(`plugin does not declare an annotation flow provider: ${id}`);
  const provider = await loadExport(installed.directory, installed.manifest.annotation_flow_provider);
  if (typeof provider !== "object" || provider === null || (provider as { apiVersion?: unknown }).apiVersion !== 1 || typeof (provider as { policy?: unknown }).policy !== "function") {
    throw new Error(`plugin annotation flow provider export is invalid: ${id}`);
  }
  const typedProvider = provider as PluginAnnotationFlowProviderV1;
  return { manifest: installed.manifest, provider: typedProvider, policy: validateAnnotationFlowPolicy(typedProvider, id) };
}

export async function loadPluginAnnotationFlowProvider(id: string, workspace = process.cwd()): Promise<LoadedPluginAnnotationFlowProvider> {
  return loadedAnnotationFlow(installedManifest(id, workspace), id);
}

export async function loadTrustedPluginAnnotationFlowProvider(id: string, trustedDirectory: string, workspace = process.cwd()): Promise<LoadedPluginAnnotationFlowProvider> {
  const installed = installedManifest(id, workspace);
  const trustedManifest = readPluginManifest(trustedDirectory, true);
  if (trustedManifest.id !== id || JSON.stringify(installed.manifest) !== JSON.stringify(trustedManifest)) {
    throw new Error(`installed annotation flow plugin does not match the bundled manifest: ${id}`);
  }
  const reference = trustedManifest.annotation_flow_provider;
  if (!reference) throw new Error(`bundled plugin does not declare an annotation flow provider: ${id}`);
  const relative = reference.module.slice(2).split("/");
  const installedDigest = createHash("sha256").update(readFileSync(path.join(installed.directory, ...relative))).digest("hex");
  const trustedDigest = createHash("sha256").update(readFileSync(path.join(trustedDirectory, ...relative))).digest("hex");
  if (installedDigest !== trustedDigest) throw new Error(`installed annotation flow plugin does not match the bundled module: ${id}`);
  return loadedAnnotationFlow(installed, id);
}

export async function loadPluginCustomCommandProvider(id: string, workspace = process.cwd()): Promise<LoadedPluginCustomCommandProvider> {
  const installed = installedManifest(id, workspace);
  const reference = installed.manifest.custom_command_provider;
  if (!reference) throw new Error(`plugin does not declare a custom command provider: ${id}`);
  const provider = await loadExport(installed.directory, reference);
  const candidate = provider as Partial<PluginCustomCommandProviderV1> | null;
  if (typeof candidate !== "object" || candidate === null || candidate.apiVersion !== 1
    || typeof candidate.list !== "function" || typeof candidate.add !== "function" || typeof candidate.remove !== "function"
    || typeof candidate.test !== "function" || typeof candidate.resolve !== "function") {
    throw new Error(`plugin custom command provider export is invalid: ${id}`);
  }
  return { manifest: installed.manifest, provider: candidate as PluginCustomCommandProviderV1 };
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
